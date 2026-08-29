import { describe, expect, it } from 'vitest'
import {
  formatFindings,
  inferScopeFromPath,
  parseServiceCommandArgs,
  runServiceCommandIfRequested
} from './orcad-service-command'

describe('flag routing', () => {
  // B1: these flags are handled before the native preflight, so a normal start must not be
  // diverted by them — and orcad's own parseArgs would reject them outright if they leaked.
  it('leaves a normal server start alone', () => {
    expect(runServiceCommandIfRequested(['--port', '6800', '--json'])).toBeNull()
    expect(runServiceCommandIfRequested([])).toBeNull()
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
      '/tmp/orcad.service'
    ])
    expect(options).toEqual({
      scope: 'user',
      user: 'orca',
      nodePath: '/usr/bin/node',
      port: 7000,
      bind: '0.0.0.0',
      servicePath: '/tmp/orcad.service'
    })
  })

  it('rejects values it cannot act on rather than guessing', () => {
    expect(() => parseServiceCommandArgs(['--scope', 'global'])).toThrow(/--scope/)
    expect(() => parseServiceCommandArgs(['--port', 'ssh'])).toThrow(/--port/)
    expect(() => parseServiceCommandArgs(['--user'])).toThrow(/--user/)
    expect(() => parseServiceCommandArgs(['--node'])).toThrow(/--node/)
    expect(() => parseServiceCommandArgs(['--service-path'])).toThrow(/--service-path/)
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
