import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonServer } from './daemon-server'
import { DaemonClient } from './client'
import { isDispatchableRequest } from './daemon-client-connections'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { DaemonRequest } from './types'

function createMockSubprocess(): SubprocessHandle {
  let notifyExit: ((code: number) => void) | null = null
  const exit = (): void => notifyExit?.(0)
  return {
    pid: 44444,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill: exit,
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: exit,
    signal() {},
    onData() {},
    onExit(callback) {
      notifyExit = callback
    },
    dispose() {}
  }
}

type DaemonServerPrivate = {
  handleRequest(socket: unknown, clientId: string, request: DaemonRequest): Promise<void>
}

/**
 * The daemon is the process deliberately kept alive so terminals outlive the runtime, the
 * supervisor and an update. Killing it destroys every terminal on the host — the same harm
 * `KillMode=mixed` exists to prevent, reached from the client side instead.
 *
 * A frame with no `id` used to do exactly that: the `.id` read sat one line above the
 * try/catch that was already there, so the TypeError escaped as an unhandled rejection and
 * the daemon's uncaughtException handler rethrew it.
 */
describe('malformed control frames', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let client: DaemonClient | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-malformed-frame-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'test.token')
  })

  afterEach(async () => {
    client?.disconnect()
    client = null
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')(
    'keeps serving after a frame with no usable id',
    async () => {
      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      const daemon = server as unknown as DaemonServerPrivate

      // Every shape the parser can hand through, `null` included — it casts whatever JSON
      // parsed straight to DaemonRequest.
      for (const frame of [null, undefined, {}, { type: 'write' }, { id: 42 }, { id: '' }]) {
        await expect(
          daemon.handleRequest({}, 'control-1', frame as unknown as DaemonRequest)
        ).resolves.toBeUndefined()
      }

      // The assertion that matters. "No throw escaped" would pass equally against a daemon
      // that had already exited cleanly, so prove it is still accepting connections and
      // still doing work.
      client = new DaemonClient({ socketPath, tokenPath })
      await client.ensureConnected()
      await expect(
        client.request('createOrAttach', { sessionId: 'after-malformed', cols: 80, rows: 24 })
      ).resolves.toMatchObject({ isNew: true })
    }
  )
})

describe('isDispatchableRequest', () => {
  // A reply has to be correlated against an id, so a frame without one is undispatchable
  // rather than merely unknown: an unknown method still gets an error reply.
  it.each([null, undefined, 42, 'string', [], {}, { type: 'write' }, { id: 42 }, { id: '' }])(
    'refuses %o',
    (message) => {
      expect(isDispatchableRequest(message)).toBe(false)
    }
  )

  it('accepts a frame carrying a non-empty string id', () => {
    expect(isDispatchableRequest({ id: 'notify_1', type: 'write' })).toBe(true)
  })
})
