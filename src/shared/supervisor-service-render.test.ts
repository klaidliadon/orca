import { describe, expect, it } from 'vitest'
import {
  renderSupervisorService,
  resolveSupervisorPlatform,
  SAFE_SYSTEMD_KILL_MODES,
  supervisorInstallHint,
  SupervisorServiceUnsupportedError,
  systemdQuote,
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

describe('paths with spaces', () => {
  // systemd splits these values on whitespace, so an unquoted space does not fail loudly —
  // it pins a truncated root and the service comes up healthy and empty, which is the exact
  // failure pinning the root exists to prevent.
  const spaced = config({
    userDataPath: '/Volumes/My Disk/.orca',
    nodePath: '/opt/my node/bin/node',
    orcadPath: '/opt/my orcad/orcad.js'
  })

  it('quotes the pinned data root so systemd reads one path, not three', () => {
    const unit = renderSupervisorService(spaced)
    expect(unit).toContain('Environment="ORCA_USER_DATA=/Volumes/My Disk/.orca"')
    expect(unit).toContain('RequiresMountsFor="/Volumes/My Disk/.orca"')
  })

  it('quotes each ExecStart word, so a spaced interpreter is not two arguments', () => {
    const execStart = /^ExecStart=(.*)$/m.exec(renderSupervisorService(spaced))?.[1]
    expect(execStart).toBe(
      '"/opt/my node/bin/node" "/opt/my orcad/orcad.js" --bind 127.0.0.1 --port 6800 --json'
    )
  })

  it('leaves ordinary paths unquoted, so the common case stays readable', () => {
    const unit = renderSupervisorService(config())
    expect(unit).toContain('Environment=ORCA_USER_DATA=/home/orca/.orca')
    expect(unit).toContain('ExecStart=/usr/local/bin/node /opt/orcad/orcad.js ')
  })

  it('escapes a quote and a backslash, which systemd unescapes inside double quotes', () => {
    expect(systemdQuote('/a path/with"quote')).toBe('"/a path/with\\"quote"')
    expect(systemdQuote('/a path/with\\slash')).toBe('"/a path/with\\\\slash"')
  })
})

describe('run-as account', () => {
  it('refuses to render a service that runs orcad as root', () => {
    expect(() => renderSupervisorService(config({ user: 'root' }))).toThrow(/root-owned data root/)
    expect(() => renderSupervisorService(config({ platform: 'launchd', user: 'root' }))).toThrow(
      /root-owned data root/
    )
  })

  // systemd's `User=` takes a name or a numeric uid, so `0` is the same account as `root`
  // spelled differently. A guard that only knows the name renders exactly the unit it exists
  // to refuse.
  it.each(['0', '00', ' 0 '])('refuses the numeric spelling of root (%j)', (user) => {
    expect(() => renderSupervisorService(config({ user }))).toThrow(/root-owned data root/)
  })

  it('does not mistake an ordinary account with a digit for root', () => {
    expect(renderSupervisorService(config({ user: 'orca0' }))).toContain('User=orca0')
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

  // `/var/log` is root-owned on macOS. A LaunchAgent runs as the operator and cannot create
  // a file there, and launchd reports that against the log path rather than the job — so the
  // service reads as a broken install for a reason the plist never names. The renderer does
  // no I/O, so it cannot resolve a home directory; naming nothing is the honest answer, and
  // the caller supplies the scope-appropriate path.
  it('never writes a log path into a plist the caller did not resolve', () => {
    const plist = renderSupervisorService(config({ platform: 'launchd', scope: 'user' }))
    expect(plist).not.toContain('/var/log/orcad.log')
    expect(plist).not.toContain('StandardOutPath')
  })

  it('emits both stream keys once the caller names a path', () => {
    const plist = renderSupervisorService(
      config({ platform: 'launchd', logPath: '/Users/orca/Library/Logs/orcad.log' })
    )
    expect(plist).toContain('<key>StandardOutPath</key>')
    expect(plist).toContain('<key>StandardErrorPath</key>')
    expect(plist.match(/Library\/Logs\/orcad\.log/g)).toHaveLength(2)
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
