import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveRealPath, versionScopedInterpreterWarning } from './supervisor-generation-warnings'

describe('version-scoped interpreter', () => {
  // One `brew upgrade node` removes the Cellar directory the unit names, and it dies
  // 203/EXEC long after the change that caused it.
  it.each([
    '/home/linuxbrew/.linuxbrew/Cellar/node/25.8.0/bin/node',
    '/opt/homebrew/Cellar/node/22.1.0/bin/node',
    '/home/me/.nvm/versions/node/v22.11.0/bin/node',
    '/home/me/.local/share/mise/installs/node/22.11.0/bin/node',
    '/home/me/.asdf/installs/nodejs/22.11.0/bin/node'
  ])('warns about %s', (nodePath) => {
    const warning = versionScopedInterpreterWarning(nodePath)
    expect(warning).not.toBeNull()
    // Points at the flag that fixes it rather than just naming the problem.
    expect(warning).toContain('--node')
  })

  it.each(['/usr/bin/node', '/usr/local/bin/node', '/home/linuxbrew/.linuxbrew/bin/node'])(
    'stays quiet about the stable path %s',
    (nodePath) => {
      expect(versionScopedInterpreterWarning(nodePath)).toBeNull()
    }
  )
})

describe('realpath resolution', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-realpath-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('resolves a symlinked ancestor, which is what RequiresMountsFor needs', () => {
    // The DSM shape: /var/services/homes -> /volume2/homes, created during boot.
    const volume = join(root, 'volume2', 'homes')
    mkdirSync(join(volume, 'master'), { recursive: true })
    const link = join(root, 'services-homes')
    symlinkSync(volume, link)
    expect(resolveRealPath(join(link, 'master'))).toBe(join(volume, 'master'))
  })

  it('resolves the existing ancestor of a data root that does not exist yet', () => {
    // The usual case at generation time: nothing has created the root, and throwing
    // there would be worse than the symlink this is fixing.
    const volume = join(root, 'volume3')
    mkdirSync(volume, { recursive: true })
    const link = join(root, 'volume3-link')
    symlinkSync(volume, link)
    expect(resolveRealPath(join(link, 'master', '.orca'))).toBe(join(volume, 'master', '.orca'))
  })

  it('returns an entirely absent path unchanged rather than throwing', () => {
    const absent = join(root, 'no', 'such', 'path')
    expect(resolveRealPath(absent)).toBe(absent)
  })
})
