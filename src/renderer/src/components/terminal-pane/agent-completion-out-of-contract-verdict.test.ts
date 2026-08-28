import { describe, expect, it, vi } from 'vitest'
import { createAgentCompletionCoordinator } from './agent-completion-coordinator'
import { useAgentCompletionCoordinatorLifecycle } from './agent-completion-coordinator-test-harness'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import type * as PtyProcessInspectionEvidenceModule from '../../../../shared/pty-process-inspection-evidence'

// Models the forward-compatibility hazard directly: a newer host publishes a
// fourth children verdict ('reparented') and a future evidence funnel admits
// it verbatim instead of coercing it to 'unverifiable'. The monitor build under
// test does NOT know the arm — completion must hang on a positively matched
// 'exited', never on "not live", or the new arm silently reads as exit
// evidence (the fall-through already fixed twice, in #16900 and #16908).
vi.mock('../../../../shared/pty-process-inspection-evidence', async (importOriginal) => {
  const real = await importOriginal<typeof PtyProcessInspectionEvidenceModule>()
  return {
    ...real,
    readPtyProcessInspectionEvidence: (
      result: Parameters<typeof real.readPtyProcessInspectionEvidence>[0]
    ) => {
      const children = result.processEvidence?.children
      if (children && (children.verdict as string) === 'reparented') {
        return result.processEvidence
      }
      return real.readPtyProcessInspectionEvidence(result)
    }
  }
})

function evidenceResult(
  foregroundProcess: string | null,
  childrenVerdict: string
): RuntimeTerminalProcessInspection {
  return {
    foregroundProcess,
    hasChildProcesses: childrenVerdict === 'live',
    processEvidence: {
      foreground: { verdict: 'observed', processName: foregroundProcess },
      children: { verdict: childrenVerdict } as never
    }
  }
}

describe('agent completion with an out-of-contract children verdict', () => {
  useAgentCompletionCoordinatorLifecycle()

  function startCoordinator(results: () => RuntimeTerminalProcessInspection) {
    const dispatchCompletion = vi.fn()
    const coordinator = createAgentCompletionCoordinator({
      paneKey: 'tab-1:leaf-1',
      getPtyId: () => 'pty-1',
      getSettings: () => null,
      inspectProcess: vi.fn(async () => results()),
      dispatchCompletion,
      isLive: () => true
    })
    coordinator.startProcessTracking()
    return { coordinator, dispatchCompletion }
  }

  it('never dispatches completion from a verdict outside the exited contract', async () => {
    let result = evidenceResult('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    // The host now answers with a verdict this build has no arm for.
    result = evidenceResult('zsh', 'reparented')
    await vi.advanceTimersByTimeAsync(60_000)

    expect(dispatchCompletion).not.toHaveBeenCalled()
  })

  it('still completes once the host positively reports exited', async () => {
    let result = evidenceResult('codex', 'live')
    const { dispatchCompletion } = startCoordinator(() => result)

    await vi.advanceTimersByTimeAsync(2_000)

    result = evidenceResult('zsh', 'reparented')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(dispatchCompletion).not.toHaveBeenCalled()

    // The unknown arm must not have wedged the monitor: a positively matched
    // exit observed afterwards still completes.
    result = evidenceResult('zsh', 'exited')
    await vi.advanceTimersByTimeAsync(30_000)

    expect(dispatchCompletion).toHaveBeenCalledTimes(1)
    expect(dispatchCompletion).toHaveBeenCalledWith('codex', {
      source: 'process-exit',
      quietedHookDone: false,
      terminalIdleConfirmed: true
    })
  })
})
