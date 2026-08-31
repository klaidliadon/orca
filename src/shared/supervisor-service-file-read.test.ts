import { describe, expect, it } from 'vitest'
import { renderSupervisorService } from './supervisor-service-render'
import {
  readConfiguredEndpoint,
  readExecTarget,
  readPinnedUserData,
  splitSystemdCommandLine,
  type SupervisorServiceFile
} from './supervisor-service-file-read'

function unit(overrides: { userDataPath?: string; nodePath?: string; orcadPath?: string } = {}) {
  const text = renderSupervisorService({
    platform: 'systemd',
    scope: 'system',
    nodePath: overrides.nodePath ?? '/usr/local/bin/node',
    orcadPath: overrides.orcadPath ?? '/opt/orcad/orcad.js',
    userDataPath: overrides.userDataPath ?? '/home/orca/.orca',
    user: 'orca',
    bind: '127.0.0.1',
    port: 6800
  })
  return {
    path: '/etc/systemd/system/orcad.service',
    text,
    platform: 'systemd',
    scope: 'system'
  } satisfies SupervisorServiceFile
}

// The generator quotes any value carrying a space, so a reader that splits on whitespace
// misreads the file this tool itself wrote — and then reports a healthy unit as pointing at
// a binary that is not there.
describe('reading back what the generator wrote', () => {
  const spaced = {
    userDataPath: '/Volumes/My Disk/.orca',
    nodePath: '/opt/my node/bin/node',
    orcadPath: '/opt/my orcad/orcad.js'
  }

  it('reads a spaced data root as one path', () => {
    expect(readPinnedUserData(unit(spaced))).toBe('/Volumes/My Disk/.orca')
  })

  it('reads a spaced interpreter and script as two words, not four', () => {
    expect(readExecTarget(unit(spaced))).toEqual({
      interpreter: '/opt/my node/bin/node',
      script: '/opt/my orcad/orcad.js'
    })
  })

  it('still finds the endpoint past a quoted interpreter', () => {
    expect(readConfiguredEndpoint(unit(spaced))).toEqual({ bind: '127.0.0.1', port: 6800 })
  })

  it('leaves an ordinary unit reading exactly as before', () => {
    expect(readPinnedUserData(unit())).toBe('/home/orca/.orca')
    expect(readExecTarget(unit())).toEqual({
      interpreter: '/usr/local/bin/node',
      script: '/opt/orcad/orcad.js'
    })
  })
})

describe('the systemd command-line splitter', () => {
  it('splits on whitespace outside quotes', () => {
    expect(splitSystemdCommandLine('/bin/node /a/b.js --port 6800')).toEqual([
      '/bin/node',
      '/a/b.js',
      '--port',
      '6800'
    ])
  })

  it('keeps a quoted run together and drops the quotes', () => {
    expect(splitSystemdCommandLine('"/opt/my node/bin/node" --json')).toEqual([
      '/opt/my node/bin/node',
      '--json'
    ])
  })

  it('unescapes a quote and a backslash inside double quotes', () => {
    expect(splitSystemdCommandLine('"/a/with\\"quote" "/b/with\\\\slash"')).toEqual([
      '/a/with"quote',
      '/b/with\\slash'
    ])
  })

  it('yields an empty word for an empty quoted argument rather than dropping it', () => {
    expect(splitSystemdCommandLine('/bin/node "" --json')).toEqual(['/bin/node', '', '--json'])
  })

  it('answers empty for an empty command line', () => {
    expect(splitSystemdCommandLine('')).toEqual([])
    expect(splitSystemdCommandLine('   ')).toEqual([])
  })
})
