import { describe, expect, it } from 'vitest'
import {
  renderSupervisorService,
  resolveSupervisorPlatform,
  SAFE_SYSTEMD_KILL_MODES,
  supervisorInstallHint,
  SupervisorServiceUnsupportedError,
  type SupervisorServiceConfig
} from './supervisor-service-render'

function config(overrides: Partial<SupervisorServiceConfig> = {}): SupervisorServiceConfig {
  return {
    platform: 'systemd',
    scope: 'system',
    nodePath: '/usr/local/bin/node',
    orcadPath: '/opt/orcad/orcad.js',
    userDataPath: '/home/orca/.orca',
    user: 'orca',
    bind: '127.0.0.1',
    port: 6800,
    ...overrides
  }
}

describe('the invariant', () => {
  // This is the feature. Everything else in this file is formatting.
  it('never renders a systemd unit whose kill mode reaps the terminal daemon', () => {
    for (const scope of ['user', 'system'] as const) {
      const unit = renderSupervisorService(config({ scope }))
      const killMode = /^KillMode\s*=\s*(.*)$/m.exec(unit)?.[1]
      expect(killMode, `scope=${scope} rendered no KillMode`).toBeDefined()
      expect(SAFE_SYSTEMD_KILL_MODES).toContain(killMode)
    }
  })

  it('never renders a launchd plist that lets launchd reap the job process group', () => {
    for (const scope of ['user', 'system'] as const) {
      const plist = renderSupervisorService(config({ platform: 'launchd', scope }))
      expect(plist).toMatch(/<key>AbandonProcessGroup<\/key>\s*<true\/>/)
    }
  })
})

describe('data root', () => {
  it('pins an absolute root into both formats', () => {
    expect(renderSupervisorService(config())).toContain(
      'Environment=ORCA_USER_DATA=/home/orca/.orca'
    )
    expect(renderSupervisorService(config({ platform: 'launchd' }))).toContain(
      '<string>/home/orca/.orca</string>'
    )
  })
})

describe('run-as account', () => {
  it('refuses to render a service that runs orcad as root', () => {
    expect(() => renderSupervisorService(config({ user: 'root' }))).toThrow(/root-owned data root/)
    expect(() => renderSupervisorService(config({ platform: 'launchd', user: 'root' }))).toThrow(
      /root-owned data root/
    )
  })

  it('names the account explicitly', () => {
    expect(renderSupervisorService(config())).toContain('User=orca')
    expect(renderSupervisorService(config({ platform: 'launchd' }))).toContain(
      '<string>orca</string>'
    )
  })
})

describe('readiness honesty', () => {
  // Under Type=simple systemd considers the unit started at fork, so a start timeout gates
  // nothing. Emitting one anyway would read like a readiness guarantee that does not exist.
  it('emits no TimeoutStartSec', () => {
    expect(renderSupervisorService(config())).not.toMatch(/^TimeoutStartSec/m)
  })

  it('prevents restart only on the configuration exit code', () => {
    expect(renderSupervisorService(config())).toContain('RestartPreventExitStatus=78')
  })
})

describe('logging', () => {
  it('uses journald on systemd rather than an unrotated file', () => {
    const unit = renderSupervisorService(config())
    expect(unit).toContain('StandardOutput=journal')
    expect(unit).not.toMatch(/StandardOutput=append:/)
  })
})

describe('escaping', () => {
  it('escapes plist-hostile characters in generated paths', () => {
    const plist = renderSupervisorService(
      config({ platform: 'launchd', userDataPath: '/home/a&b/<orca>' })
    )
    expect(plist).toContain('/home/a&amp;b/&lt;orca&gt;')
    expect(plist).not.toContain('/home/a&b/<orca>')
  })
})

describe('scope', () => {
  it('targets default.target for a user unit and multi-user.target for a system one', () => {
    expect(renderSupervisorService(config({ scope: 'user' }))).toContain('WantedBy=default.target')
    expect(renderSupervisorService(config({ scope: 'system' }))).toContain(
      'WantedBy=multi-user.target'
    )
  })

  it('warns in the plist that a LaunchAgent stops at logout', () => {
    const agent = renderSupervisorService(config({ platform: 'launchd', scope: 'user' }))
    expect(agent).toMatch(/only while this user is logged in/i)
  })

  it('tells a user-scope systemd install to enable lingering', () => {
    const hint = supervisorInstallHint(config({ scope: 'user' }))
    expect(hint.commands.join('\n')).toContain('enable-linger')
  })

  // `--now` arrived in systemd 220. The hint is the operator's next action, so naming a
  // flag their systemd does not have leaves the unit installed but neither enabled nor
  // started — indistinguishable from a successful install until the next reboot.
  // Measured on Synology DSM (systemd 219): `unrecognized option '--now'`.
  it.each(['system', 'user'] as const)(
    'never tells a %s systemd install to use `--now`',
    (scope) => {
      const commands = supervisorInstallHint(config({ scope })).commands.join('\n')
      expect(commands).not.toContain('--now')
      expect(commands).toContain('systemctl')
    }
  )

  it.each(['system', 'user'] as const)(
    'enables AND starts a %s systemd unit, since neither alone is enough',
    (scope) => {
      const commands = supervisorInstallHint(config({ scope })).commands
      // enable without start leaves it dead until reboot; start without enable dies at one.
      expect(commands.some((c) => /systemctl.* enable /.test(c))).toBe(true)
      expect(commands.some((c) => /systemctl.* start /.test(c))).toBe(true)
    }
  )
})

describe('platform resolution', () => {
  it('maps the two supported platforms', () => {
    expect(resolveSupervisorPlatform('linux')).toBe('systemd')
    expect(resolveSupervisorPlatform('darwin')).toBe('launchd')
  })

  it('refuses win32 rather than emitting something plausible', () => {
    expect(() => resolveSupervisorPlatform('win32')).toThrow(SupervisorServiceUnsupportedError)
  })
})

describe('mount ordering', () => {
  // systemd maps RequiresMountsFor to a mount unit textually, walking up parent
  // directories, so it only reaches a real mount when the caller passed a realpath.
  it('orders the unit after the mount carrying the data root', () => {
    const unit = renderSupervisorService(config({ userDataPath: '/volume2/homes/me/.orca' }))
    expect(unit).toContain('RequiresMountsFor=/volume2/homes/me/.orca')
  })

  it('puts it in [Unit], where systemd reads it', () => {
    const unit = renderSupervisorService(config())
    const unitSection = unit.slice(unit.indexOf('[Unit]'), unit.indexOf('[Service]'))
    expect(unitSection).toMatch(/^RequiresMountsFor=/m)
  })

  it('names the same path the service will actually use', () => {
    const unit = renderSupervisorService(config({ userDataPath: '/volume2/homes/me/.orca' }))
    const mount = /^RequiresMountsFor=(.*)$/m.exec(unit)?.[1]
    const environment = /^Environment=ORCA_USER_DATA=(.*)$/m.exec(unit)?.[1]
    expect(mount).toBe(environment)
  })
})
