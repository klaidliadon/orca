import { describe, expect, it } from 'vitest'
import {
  auditSupervisorServices,
  supervisorAuditPassed,
  type SupervisorServiceFile
} from './supervisor-service-audit'
import { renderSupervisorService } from './supervisor-service-render'

const ROOT = '/home/orca/.orca'

function file(overrides: Partial<SupervisorServiceFile> = {}): SupervisorServiceFile {
  return {
    path: '/etc/systemd/system/orcad.service',
    platform: 'systemd',
    scope: 'system',
    text: renderSupervisorService({
      platform: 'systemd',
      scope: 'system',
      nodePath: '/usr/local/bin/node',
      orcadPath: '/opt/orcad/orcad.js',
      userDataPath: ROOT,
      user: 'orca',
      bind: '127.0.0.1',
      port: 6800
    }),
    ...overrides
  }
}

function audit(files: SupervisorServiceFile[], expected = ROOT) {
  return auditSupervisorServices({ files, expectedUserDataPath: expected })
}

function codes(files: SupervisorServiceFile[], expected = ROOT): string[] {
  return audit(files, expected).map((finding) => finding.code)
}

/** What `brew services` produces: a plausible unit with no KillMode at all. */
const HOMEBREW_SHAPED_UNIT = `[Unit]
Description=Homebrew generated unit for orcad

[Service]
Type=simple
ExecStart=/opt/homebrew/bin/node /opt/homebrew/opt/orcad/orcad.js
Restart=always
User=orca
Environment=ORCA_USER_DATA=${ROOT}

[Install]
WantedBy=multi-user.target
`

describe('kill semantics', () => {
  it('passes its own rendered output', () => {
    expect(supervisorAuditPassed(audit([file()]))).toBe(true)
  })

  it('flags a brew-services-shaped unit as critical', () => {
    const findings = audit([file({ text: HOMEBREW_SHAPED_UNIT })])
    expect(findings[0].code).toBe('kill_mode_missing')
    expect(findings[0].severity).toBe('critical')
    expect(supervisorAuditPassed(findings)).toBe(false)
  })

  it('flags an explicit control-group', () => {
    const text = file().text.replace('KillMode=mixed', 'KillMode=control-group')
    expect(codes([file({ text })])).toContain('kill_mode_reaps_group')
  })

  it('warns rather than blesses KillMode=none, which signals nothing at all', () => {
    const text = file().text.replace('KillMode=mixed', 'KillMode=none')
    const findings = audit([file({ text })])
    expect(findings.map((f) => f.code)).toContain('kill_mode_discouraged')
    // It spares the daemon, so it is not the critical failure this audit exists to catch.
    expect(supervisorAuditPassed(findings)).toBe(true)
  })

  it('does not read a commented-out KillMode as set', () => {
    const text = file().text.replace('KillMode=mixed', '# KillMode=mixed')
    expect(codes([file({ text })])).toContain('kill_mode_missing')
  })

  it('accepts a plist only when AbandonProcessGroup is stated', () => {
    const plist = renderSupervisorService({
      platform: 'launchd',
      scope: 'system',
      nodePath: '/usr/local/bin/node',
      orcadPath: '/opt/orcad/orcad.js',
      userDataPath: ROOT,
      user: 'orca',
      bind: '127.0.0.1',
      port: 6800
    })
    expect(codes([file({ platform: 'launchd', text: plist })])).toContain('kill_semantics_safe')

    const stripped = plist.replace(/<key>AbandonProcessGroup<\/key>\s*<true\/>/, '')
    const findings = audit([file({ platform: 'launchd', text: stripped })])
    expect(findings.map((f) => f.code)).toContain('kill_semantics_implicit')
    // Implicit survival is a warning, not a failure: it does work today.
    expect(supervisorAuditPassed(findings)).toBe(true)
  })
})

describe('data root', () => {
  it('flags an unpinned root as critical', () => {
    const text = file().text.replace(`Environment=ORCA_USER_DATA=${ROOT}`, '')
    expect(codes([file({ text })])).toContain('user_data_unpinned')
  })

  it('reports disagreement with the calling shell as a warning, not a failure', () => {
    const findings = audit([file()], '/home/someone-else/.orca')
    expect(findings.map((f) => f.code)).toContain('user_data_mismatch')
    expect(supervisorAuditPassed(findings)).toBe(true)
  })
})

describe('run-as account', () => {
  it('flags a system unit with no User', () => {
    const text = file().text.replace('User=orca', '')
    expect(codes([file({ text })])).toContain('run_as_user_unset')
  })

  it('flags User=root', () => {
    const text = file().text.replace('User=orca', 'User=root')
    expect(codes([file({ text })])).toContain('run_as_root')
  })

  it('accepts a user-scope unit with no User', () => {
    const text = file().text.replace('User=orca', '')
    const findings = audit([file({ text, scope: 'user' })])
    expect(supervisorAuditPassed(findings)).toBe(true)
  })
})

describe('duplicates', () => {
  it('ranks two services on one data root above everything else', () => {
    const findings = audit([
      file(),
      file({ path: '/home/orca/.config/systemd/user/orcad.service', scope: 'user' })
    ])
    expect(findings[0].code).toBe('multiple_services_one_root')
    expect(findings[0].severity).toBe('critical')
    expect(findings[0].message).toMatch(/exits 78/)
  })

  it('treats distinct roots as a warning only', () => {
    const other = file({
      path: '/home/orca/.config/systemd/user/orcad.service',
      scope: 'user',
      text: file().text.replace(ROOT, '/srv/other/.orca')
    })
    const findings = audit([file(), other])
    expect(findings.map((f) => f.code)).toContain('multiple_services_distinct_roots')
  })
})

describe('unverifiable is never a negative verdict', () => {
  it('reports a missing service as unverified rather than clean or failed', () => {
    const findings = audit([])
    expect(findings[0].severity).toBe('unverifiable')
    // Nothing found is not evidence of a broken host, so it must not fail the audit.
    expect(supervisorAuditPassed(findings)).toBe(true)
  })

  it('reports lingering as unreadable from a user unit rather than guessing', () => {
    const findings = audit([file({ scope: 'user' })])
    const linger = findings.find((f) => f.code === 'linger_unverified')
    expect(linger?.severity).toBe('unverifiable')
    expect(linger?.remedy).toContain('enable-linger')
  })

  it('warns that a LaunchAgent dies at logout', () => {
    expect(codes([file({ platform: 'launchd', scope: 'user' })])).toContain('launch_agent_scope')
  })
})
