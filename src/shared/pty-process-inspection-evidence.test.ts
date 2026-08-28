import { describe, expect, it } from 'vitest'
import {
  readPtyProcessInspectionEvidence,
  type PtyProcessInspectionEvidence
} from './pty-process-inspection-evidence'

// Pins the normalize funnel at the contract level, independent of any
// consumer's own polarity guard: a foreign host's out-of-contract or
// malformed evidence must coerce to 'unverifiable', never pass through
// as something a consumer could mistake for an observation.
describe('readPtyProcessInspectionEvidence normalization', () => {
  it('coerces an out-of-contract children verdict to unverifiable', () => {
    const evidence = readPtyProcessInspectionEvidence({
      foregroundProcess: null,
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'observed', processName: null },
        children: { verdict: 'someday-new-verdict' } as never
      }
    })
    expect(evidence.children).toEqual({
      verdict: 'unverifiable',
      reason: 'malformed child-process inspection evidence'
    })
  })

  it('coerces an out-of-contract foreground verdict to unverifiable', () => {
    const evidence = readPtyProcessInspectionEvidence({
      foregroundProcess: null,
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'someday-new-verdict' } as never,
        children: { verdict: 'exited' }
      }
    })
    expect(evidence.foreground).toEqual({
      verdict: 'unverifiable',
      reason: 'malformed foreground inspection evidence'
    })
  })

  it('defaults a missing unverifiable reason instead of trusting the shape', () => {
    const evidence = readPtyProcessInspectionEvidence({
      foregroundProcess: null,
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'unverifiable' },
        children: { verdict: 'unverifiable' }
      } as PtyProcessInspectionEvidence
    })
    expect(evidence.foreground).toEqual({ verdict: 'unverifiable', reason: 'unspecified' })
    expect(evidence.children).toEqual({ verdict: 'unverifiable', reason: 'unspecified' })
  })

  it('synthesizes the legacy reading when the host predates evidence', () => {
    expect(
      readPtyProcessInspectionEvidence({ foregroundProcess: 'codex', hasChildProcesses: true })
    ).toEqual({
      foreground: { verdict: 'observed', processName: 'codex' },
      children: { verdict: 'live' }
    })
    expect(
      readPtyProcessInspectionEvidence({ foregroundProcess: null, hasChildProcesses: false })
    ).toEqual({
      foreground: { verdict: 'observed', processName: null },
      children: { verdict: 'exited' }
    })
  })
})
