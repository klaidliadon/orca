// The daemon's synchronous foreground read cannot tell node-pty's silent
// shell-title fallback from a real idle shell on its own, so a shell-shaped
// title is only an observation while a completed scan corroborates it. Pins
// how each scan outcome settles (docs/reference/ssh-execution-boundary.md).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as pty from 'node-pty'

const resolveAgentForegroundProcessMock = vi.hoisted(() => vi.fn())
vi.mock('../providers/agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

import { createDaemonPtySubprocessHandle } from './pty-subprocess/subprocess-handle'
import type { SubprocessHandle } from './session-subprocess-handle'

const SHELL_PID = 999_999_517
// Above the idle-shell refresh throttle (5s) so each read starts a fresh scan.
const PAST_THE_SCAN_THROTTLE_MS = 6_000

describe('daemon foreground observation evidence', () => {
  let platformDescriptor: PropertyDescriptor | undefined
  let nodePty: pty.IPty & { process: string }
  let handle: SubprocessHandle

  async function readAfterSettledScan(): Promise<ReturnType<
    NonNullable<SubprocessHandle['observeForegroundProcess']>
  > | null> {
    // A read schedules the next scan rather than awaiting one, and the
    // throttle can swallow the read that follows a scan. Two cycles guarantee
    // one scan both started and settled under the behavior set by this test.
    for (let cycle = 0; cycle < 2; cycle++) {
      handle.observeForegroundProcess?.()
      await vi.advanceTimersByTimeAsync(PAST_THE_SCAN_THROTTLE_MS)
    }
    return handle.observeForegroundProcess?.() ?? null
  }

  beforeEach(() => {
    vi.useFakeTimers()
    platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    resolveAgentForegroundProcessMock.mockReset()
    // Default: a scan that runs and finds no agent. Individual tests override.
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: true, processName: 'zsh' })
    nodePty = {
      pid: SHELL_PID,
      process: 'zsh',
      onData: vi.fn(() => ({ dispose: vi.fn() })),
      onExit: vi.fn(() => ({ dispose: vi.fn() })),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn()
    } as unknown as pty.IPty & { process: string }
    handle = createDaemonPtySubprocessHandle({
      process: nodePty,
      shellPath: '/bin/zsh',
      spawnCwd: '/tmp/wt',
      env: { PATH: '/usr/bin' },
      startupCommandDeliveredInShellArgs: false,
      reportsChildExitStatus: true,
      requestedCwd: '/tmp/wt',
      sessionId: 'repo-observe::/tmp/wt@@observe01',
      startupAgentRecognition: null
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
    vi.restoreAllMocks()
  })

  it('withholds observation from a shell title no scan has corroborated', () => {
    const observation = handle.observeForegroundProcess?.()

    expect(observation?.processName).toBe('zsh')
    expect(observation?.evidence.verdict).toBe('unverifiable')
  })

  it('observes the shell once a completed scan agrees the pane is idle', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: true, processName: 'zsh' })

    const observation = await readAfterSettledScan()

    expect(observation?.processName).toBe('zsh')
    expect(observation?.evidence).toEqual({ verdict: 'observed', processName: 'zsh' })
  })

  it('withholds observation when the scan ran but could not answer', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: false, processName: 'zsh' })

    const observation = await readAfterSettledScan()

    expect(observation?.evidence.verdict).toBe('unverifiable')
  })

  it('withholds observation after a corroborating scan is followed by a thrown one', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: true, processName: 'zsh' })
    expect((await readAfterSettledScan())?.evidence.verdict).toBe('observed')

    // A scan that rejects observed nothing; the corroboration it would have
    // refreshed must not be inherited from the last one that succeeded.
    resolveAgentForegroundProcessMock.mockRejectedValue(new Error('ps fork failed'))
    const observation = await readAfterSettledScan()

    expect(observation?.evidence.verdict).toBe('unverifiable')
  })

  it('keeps a live agent title an observation without needing a scan', () => {
    nodePty.process = 'codex'

    expect(handle.observeForegroundProcess?.()?.evidence).toEqual({
      verdict: 'observed',
      processName: 'codex'
    })
  })

  it('leaves the legacy foreground read identical to the observed name', async () => {
    resolveAgentForegroundProcessMock.mockResolvedValue({ available: false, processName: 'zsh' })
    await readAfterSettledScan()

    // The wire's legacy field must not change shape when evidence degrades.
    expect(handle.getForegroundProcess()).toBe('zsh')
  })
})
