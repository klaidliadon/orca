import { describe, expect, it } from 'vitest'
import {
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
