import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import {
  collectServiceFiles,
  formatFindings,
  inferScopeFromPath,
  isServiceCommand,
  parseServiceCommandArgs
} from './orcad-service-command'

describe('flag routing', () => {
  // B1: these flags are handled before the native preflight, so a normal start must not be
  // diverted by them — and orcad's own parseArgs would reject them outright if they leaked.
  it('leaves a normal server start alone', () => {
    expect(isServiceCommand(['--port', '6800', '--json'])).toBe(false)
    expect(isServiceCommand([])).toBe(false)
  })

  it('claims the invocation for either service flag', () => {
    expect(isServiceCommand(['--print-service'])).toBe(true)
    expect(isServiceCommand(['--doctor'])).toBe(true)
  })
})

describe('argument parsing', () => {
  it('defaults to a system-scope loopback service', () => {
    const options = parseServiceCommandArgs(['--print-service'])
    expect(options).toMatchObject({ scope: 'system', bind: '127.0.0.1', port: 6800 })
    expect(options.user).toBeUndefined()
  })

  it('reads every override', () => {
    const options = parseServiceCommandArgs([
      '--print-service',
      '--scope',
      'user',
      '--user',
      'orca',
      '--node',
      '/usr/bin/node',
      '--port',
      '7000',
      '--bind',
      '0.0.0.0',
      '--service-path',
      '/tmp/orcad.service',
      '--no-probe'
    ])
    expect(options).toEqual({
      scope: 'user',
      user: 'orca',
      nodePath: '/usr/bin/node',
      port: 7000,
      bind: '0.0.0.0',
      servicePath: '/tmp/orcad.service',
      noProbe: true
    })
  })

  it('rejects values it cannot act on rather than guessing', () => {
    expect(() => parseServiceCommandArgs(['--scope', 'global'])).toThrow(/--scope/)
    expect(() => parseServiceCommandArgs(['--port', 'ssh'])).toThrow(/--port/)
    expect(() => parseServiceCommandArgs(['--user'])).toThrow(/--user/)
    expect(() => parseServiceCommandArgs(['--node'])).toThrow(/--node/)
    expect(() => parseServiceCommandArgs(['--service-path'])).toThrow(/--service-path/)
  })

  // Silently dropping these is how `--user-data` came to be recommended by the tool's own
  // socket-budget remedy: an operator ran it, got exit 0 and an [OK], and had changed
  // nothing. `--json` is the same shape — real on `orca supervisor doctor`, absent here.
  it('rejects a flag it does not implement instead of ignoring it', () => {
    expect(() => parseServiceCommandArgs(['--doctor', '--user-data', '/tmp/x'])).toThrow(
      /Unknown argument: --user-data/
    )
    expect(() => parseServiceCommandArgs(['--doctor', '--json'])).toThrow(
      /Unknown argument: --json/
    )
  })

  // The mode flags travel in the same argv this parses, so they are not "unknown".
  it('accepts the mode flags it is invoked through', () => {
    expect(() => parseServiceCommandArgs(['--print-service'])).not.toThrow()
    expect(() => parseServiceCommandArgs(['--doctor', '--no-probe'])).not.toThrow()
  })

  // A value consumed by its flag must not then be re-read as an argument.
  it('does not mistake a flag value for an unknown flag', () => {
    expect(() =>
      parseServiceCommandArgs(['--doctor', '--service-path', '/tmp/--json.service'])
    ).not.toThrow()
  })
})

describe('scope inference', () => {
  // Mislabelling a user-scope file as system makes the audit report its correct missing
  // run-as account as critical.
  it('reads user scope out of the conventional paths', () => {
    expect(inferScopeFromPath('/home/orca/.config/systemd/user/orcad.service')).toBe('user')
    expect(inferScopeFromPath('/Users/orca/Library/LaunchAgents/dev.onorca.orcad.plist')).toBe(
      'user'
    )
  })

  it('treats everything else as system scope', () => {
    expect(inferScopeFromPath('/etc/systemd/system/orcad.service')).toBe('system')
    expect(inferScopeFromPath('/Library/LaunchDaemons/dev.onorca.orcad.plist')).toBe('system')
    expect(inferScopeFromPath('/tmp/scratch.service')).toBe('system')
  })
})

describe('finding output', () => {
  it('indents a remedy under its finding', () => {
    const text = formatFindings([
      {
        code: 'kill_mode_missing',
        severity: 'critical',
        message: 'No KillMode.',
        remedy: 'Regenerate.'
      },
      { code: 'user_data_agrees', severity: 'ok', message: 'Root pinned.' }
    ])
    expect(text).toBe('[CRITICAL] No KillMode.\n         Regenerate.\n[OK] Root pinned.')
  })
})

/**
 * Presence and readability are different answers, and `existsSync` only reports the first:
 * it succeeds on a file the caller cannot open, because a traversable parent is enough.
 *
 * These run only as non-root by necessity, not by preference — uid 0 ignores the mode bits,
 * so the unreadable file simply reads fine and the case cannot exist. Exercised as uid 1026
 * on the Synology box where the original was found.
 */
describe('discovery separates unreadable from absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-discovery-'))
  afterAll(() => {
    try {
      chmodSync(join(dir, 'orcad.service'), 0o600)
    } catch {
      // Already gone, or never created because the test was skipped.
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it.runIf(process.getuid?.() !== 0)('records a present-but-unreadable candidate', () => {
    const path = join(dir, 'orcad.service')
    writeFileSync(path, '[Service]\nExecStart=/bin/true\n', 'utf8')
    chmodSync(path, 0o000)

    const { files, unreadable } = collectServiceFiles('systemd', [path])

    expect(files.map((f) => f.path)).not.toContain(path)
    expect(unreadable.map((u) => u.path)).toContain(path)
    expect(unreadable.find((u) => u.path === path)?.reason).toBe('EACCES')
  })

  // Scoped to the path under test rather than to the whole result: discovery also scans the
  // conventional locations, so a host with a real orcad.service installed would otherwise
  // fail these on its own installation.
  it('reports a path that truly is not there as neither found nor unreadable', () => {
    const path = join(dir, 'absent.service')
    const { files, unreadable } = collectServiceFiles('systemd', [path])
    expect(files.map((f) => f.path)).not.toContain(path)
    expect(unreadable.map((u) => u.path)).not.toContain(path)
  })

  it('reads a candidate it can open', () => {
    const path = join(dir, 'readable.service')
    writeFileSync(path, '[Service]\nKillMode=process\n', 'utf8')
    const { files, unreadable } = collectServiceFiles('systemd', [path])
    expect(files.map((f) => f.path)).toContain(path)
    expect(unreadable.map((u) => u.path)).not.toContain(path)
  })
})
