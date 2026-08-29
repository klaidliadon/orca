/**
 * `orcad --print-service` and `orcad --doctor`.
 *
 * Why these live in orcad rather than only the `orca` CLI: the shipped orcad artifact is
 * three files and no CLI (`ORCAD_ARTIFACTS`), so a host that installed only the orcad
 * tarball — the deployment this exists for — has no `orca` binary to run. The CLI can
 * mirror these over the same pure functions where it happens to be installed.
 *
 * Both are handled before `runOrcadNativePreflight()` in `main.ts`, for the reason already
 * written there: proving something must not bind a port or take the data-root lock. Data
 * root resolution is pure environment reads, so the pinned value is available that early.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import {
  auditSupervisorServices,
  readConfiguredEndpoint,
  supervisorAuditPassed,
  type SupervisorFinding,
  type SupervisorServiceFile
} from '../../shared/supervisor-service-audit'
import { gatherSupervisorEvidence } from '../../shared/supervisor-service-probe'
import type { ProbeTarget } from '../../shared/supervisor-service-probe'
import {
  ORCAD_LAUNCHD_LABEL,
  ORCAD_SYSTEMD_UNIT_NAME,
  renderSupervisorService,
  resolveSupervisorPlatform,
  supervisorInstallHint,
  SupervisorServiceUnsupportedError,
  type SupervisorPlatform,
  type SupervisorScope
} from '../../shared/supervisor-service-render'
import { resolveUserDataPath } from './orcad-app-paths'

export const PRINT_SERVICE_FLAG = '--print-service'
export const DOCTOR_FLAG = '--doctor'

const DEFAULT_PORT = 6800

type ServiceCommandOptions = {
  scope: SupervisorScope
  nodePath?: string
  user?: string
  port: number
  bind: string
  /** Audit a definition outside the conventional locations. */
  servicePath?: string
  /** Skip live probes: the file-only audit, for a host where shelling out is unwanted. */
  noProbe?: boolean
}

/**
 * Deliberately separate from `parseArgs`: that one throws on any unknown argument and is
 * reached only from `main()`, which is past the point where a port gets bound.
 */
export function parseServiceCommandArgs(argv: string[]): ServiceCommandOptions {
  const options: ServiceCommandOptions = { scope: 'system', port: DEFAULT_PORT, bind: '127.0.0.1' }
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1]
    if (argv[i] === '--scope') {
      if (value !== 'user' && value !== 'system') {
        throw new Error(`--scope expects 'user' or 'system', got ${value ?? "''"}`)
      }
      options.scope = value
      i += 1
    } else if (argv[i] === '--node') {
      if (!value) {
        throw new Error('--node expects a path')
      }
      options.nodePath = value
      i += 1
    } else if (argv[i] === '--user') {
      if (!value) {
        throw new Error('--user expects an account name')
      }
      options.user = value
      i += 1
    } else if (argv[i] === '--service-path') {
      if (!value) {
        throw new Error('--service-path expects a path')
      }
      options.servicePath = value
      i += 1
    } else if (argv[i] === '--no-probe') {
      options.noProbe = true
    } else if (argv[i] === '--port') {
      const port = Number(value)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`--port expects an integer 0-65535, got ${value ?? "''"}`)
      }
      options.port = port
      i += 1
    } else if (argv[i] === '--bind') {
      if (!value) {
        throw new Error('--bind expects a value')
      }
      options.bind = value
      i += 1
    }
  }
  return options
}

/**
 * Why argv[1] and not cwd: the same reason `resolveOrcadInstallRoot` uses it — cwd is
 * wherever the operator happened to be, so a sibling resolved against it is found by luck.
 */
function resolveOrcadEntryPath(): string {
  const entry = process.argv[1]
  if (!entry) {
    throw new Error('cannot resolve this orcad bundle: process.argv[1] is unset')
  }
  return resolve(entry)
}

export function printService(argv: string[]): number {
  const options = parseServiceCommandArgs(argv)
  const platform = resolveSupervisorPlatform(process.platform)
  const config = {
    platform,
    scope: options.scope,
    nodePath: options.nodePath ?? process.execPath,
    orcadPath: resolveOrcadEntryPath(),
    userDataPath: resolveUserDataPath(),
    // Generating as root is normal (sudo, a container); running orcad as root is not, so
    // the account is a flag rather than an inheritance.
    user: options.user ?? userInfo().username,
    bind: options.bind,
    port: options.port
  }
  const hint = supervisorInstallHint(config)
  process.stdout.write(renderSupervisorService(config))
  // Why stderr: stdout is the file, so it stays pipeable straight into the target path.
  process.stderr.write(
    `\nWrite this to: ${hint.path}\nThen run:\n${hint.commands.map((c) => `  ${c}`).join('\n')}\n`
  )
  return 0
}

/** The conventional locations, both scopes, for the platform we are on. */
function candidateServicePaths(
  platform: SupervisorPlatform
): { path: string; scope: SupervisorScope }[] {
  if (platform === 'launchd') {
    return [
      { path: join('/Library/LaunchDaemons', `${ORCAD_LAUNCHD_LABEL}.plist`), scope: 'system' },
      {
        path: join(homedir(), 'Library', 'LaunchAgents', `${ORCAD_LAUNCHD_LABEL}.plist`),
        scope: 'user'
      }
    ]
  }
  return [
    { path: join('/etc/systemd/system', ORCAD_SYSTEMD_UNIT_NAME), scope: 'system' },
    { path: join('/usr/lib/systemd/system', ORCAD_SYSTEMD_UNIT_NAME), scope: 'system' },
    { path: join(homedir(), '.config', 'systemd', 'user', ORCAD_SYSTEMD_UNIT_NAME), scope: 'user' }
  ]
}

/**
 * Why infer rather than default to system: mislabelling a user-scope file makes the audit
 * report its (correct) missing run-as account as critical.
 */
export function inferScopeFromPath(path: string): SupervisorScope {
  const normalized = path.split('\\').join('/')
  return /\/systemd\/user\/|\/LaunchAgents\//i.test(normalized) ? 'user' : 'system'
}

/**
 * Reads every candidate rather than stopping at the first: two definitions targeting one
 * data root is itself the highest-severity finding, and stopping early would hide it.
 */
export function collectServiceFiles(
  platform: SupervisorPlatform,
  extraPaths: string[] = []
): SupervisorServiceFile[] {
  const candidates = [
    ...candidateServicePaths(platform),
    ...extraPaths.map((path) => ({ path, scope: inferScopeFromPath(path) }))
  ]
  const files: SupervisorServiceFile[] = []
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate.path) || !statSync(candidate.path).isFile()) {
        continue
      }
      files.push({
        path: candidate.path,
        text: readFileSync(candidate.path, 'utf8'),
        platform,
        scope: candidate.scope
      })
    } catch {
      // An unreadable candidate is not an absent one, but nothing here can prove which;
      // `auditSupervisorServices` reports "none found" as unverifiable rather than clean.
    }
  }
  return files
}

const SEVERITY_LABEL = {
  critical: 'CRITICAL',
  warning: 'WARN',
  unverifiable: 'UNVERIFIED',
  ok: 'OK'
} as const

export function formatFindings(findings: SupervisorFinding[]): string {
  return findings
    .map((finding) => {
      const head = `[${SEVERITY_LABEL[finding.severity]}] ${finding.message}`
      return finding.remedy ? `${head}\n         ${finding.remedy}` : head
    })
    .join('\n')
}

/**
 * Why the discovered file's own basename and not a constant: discovery searches the
 * conventional locations AND accepts an explicit path, precisely because an operator may
 * have renamed things. Probing a constant would query a unit that does not exist and
 * report the file we did find as not running.
 */
function probeTargetFor(file: SupervisorServiceFile, options: ServiceCommandOptions): ProbeTarget {
  const name = basename(file.path, file.platform === 'launchd' ? '.plist' : '')
  // The endpoint comes from the file for the same reason the unit name does: the flags
  // describe what to generate, the file describes what is actually installed.
  const endpoint = readConfiguredEndpoint(file)
  return {
    platform: file.platform,
    scope: file.scope,
    name,
    user: options.user ?? userInfo().username,
    bind: endpoint?.bind ?? options.bind,
    port: endpoint?.port ?? options.port
  }
}

export async function runDoctor(argv: string[]): Promise<number> {
  const platform = resolveSupervisorPlatform(process.platform)
  const options = parseServiceCommandArgs(argv)
  const files = collectServiceFiles(platform, options.servicePath ? [options.servicePath] : [])
  // Only probe when there is exactly one definition: with two, every probe result would be
  // ambiguous about which one it described, and the duplicate finding is the story anyway.
  const evidence =
    files.length === 1 && !options.noProbe
      ? await gatherSupervisorEvidence(probeTargetFor(files[0], options))
      : undefined
  const findings = auditSupervisorServices({
    files,
    expectedUserDataPath: resolveUserDataPath(),
    evidence
  })
  process.stdout.write(`${formatFindings(findings)}\n`)
  // Why not non-zero on unverifiable: a check this could not run is not a failed check,
  // and a doctor that exits 1 on "could not verify" trains operators to ignore it.
  return supervisorAuditPassed(findings) ? 0 : 1
}

/**
 * Returns null when this invocation is a normal server start, so `main.ts` can keep the
 * early-exit block a straight-line read.
 */
/** True when this invocation is a service command rather than a server start. */
export function isServiceCommand(argv: string[]): boolean {
  return argv.includes(PRINT_SERVICE_FLAG) || argv.includes(DOCTOR_FLAG)
}

export async function runServiceCommand(argv: string[]): Promise<number> {
  try {
    return argv.includes(PRINT_SERVICE_FLAG) ? printService(argv) : await runDoctor(argv)
  } catch (error) {
    const unsupported = error instanceof SupervisorServiceUnsupportedError
    process.stderr.write(`orcad: ${error instanceof Error ? error.message : String(error)}\n`)
    // 78 is EX_CONFIG: an unsupported platform or a bad flag is not fixed by retrying.
    return unsupported ? 78 : 1
  }
}
