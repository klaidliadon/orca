/**
 * The two things `orcad --print-service` can see about this host that the generated file
 * cannot say for itself.
 *
 * Both are warnings rather than refusals: a definition is often generated on one host to be
 * installed on another, so an unusable local scope is not proof the file is wrong.
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { runProcess } from '../../shared/child-process/run-process'

/**
 * Version-scoped interpreter prefixes: a `brew upgrade node`, `nvm install`, or `mise use`
 * removes the directory the pinned path names, and the unit then dies 203/EXEC long after
 * the change that caused it.
 */
// The `\.?` matters: these tools install to a dotted directory (`.nvm`, `.asdf`) in a home
// directory but an undotted one under a shared prefix, and only one of those spellings
// would otherwise match.
const VERSION_SCOPED_INTERPRETER =
  /\/Cellar\/|\/\.?nvm\/versions\/|\/\.?mise\/installs\/|\/\.?asdf\/installs\/|\/\.?volta\/tools\/image\//

/**
 * Why warn and not silently rewrite: "the service runs the node that generated it" is the
 * contract, and guessing which stable symlink an operator meant is how a service ends up
 * on an interpreter nobody chose.
 */
export function versionScopedInterpreterWarning(nodePath: string): string | null {
  if (!VERSION_SCOPED_INTERPRETER.test(nodePath)) {
    return null
  }
  return (
    `Warning: ExecStart pins ${nodePath}, which is a version-scoped path. ` +
    'Upgrading that package manager removes the directory and the service then fails ' +
    '203/EXEC. Pass --node with a stable path (the manager’s current-version symlink) ' +
    'if you want the service to survive an interpreter upgrade.'
  )
}

/**
 * A user-scope systemd service needs a running user instance, and the install commands
 * (`systemctl --user`, `loginctl enable-linger`) all fail without one. Appliance hosts
 * routinely have no per-user D-Bus and no `/run/user/<uid>` at all.
 */
export async function userScopeUnavailableWarning(): Promise<string | null> {
  const uid = process.getuid?.()
  if (uid === undefined) {
    return null
  }
  const runtimeDir = join('/run/user', String(uid))
  if (!existsSync(runtimeDir)) {
    return (
      `Warning: no ${runtimeDir}, so this host has no systemd user instance and no user ` +
      'D-Bus session. The install commands below will fail here; generate with ' +
      '--scope system, or install this file on a host where user scope is available.'
    )
  }
  try {
    const probe = await runProcess({
      program: 'systemctl',
      args: ['--user', 'show-environment'],
      timeoutMs: 5_000
    })
    if (probe.code === 0 && !probe.timedOut) {
      return null
    }
    const detail = (probe.stderr || probe.stdout).trim().split('\n')[0]
    return (
      'Warning: the systemd user instance is not available here' +
      `${detail ? ` (${detail})` : ''}. The install commands below will fail; generate ` +
      'with --scope system, or install this file on a host where user scope is available.'
    )
  } catch (error) {
    return (
      'Warning: could not reach the systemd user instance ' +
      `(${error instanceof Error ? error.message : String(error)}). The install commands ` +
      'below will fail here; generate with --scope system instead.'
    )
  }
}

/**
 * The deepest existing ancestor, resolved, with the not-yet-created tail re-appended.
 *
 * Why not plain `realpathSync`: the data root usually does not exist when a service is
 * first generated, and throwing there would be worse than the symlink it is fixing.
 * Components that do not exist cannot themselves be symlinks, so re-appending them is
 * still a fully-resolved path.
 */
export function resolveRealPath(target: string): string {
  const tail: string[] = []
  let current = target
  for (;;) {
    try {
      return join(realpathSync(current), ...tail)
    } catch {
      const parent = dirname(current)
      if (parent === current) {
        return target
      }
      tail.unshift(current.slice(parent.length + 1))
      current = parent
    }
  }
}
