/**
 * Turns live evidence about a running orcad service into findings.
 *
 * Split from the file audit for one reason worth stating plainly: `critical` means THIS
 * CONFIGURATION WILL DESTROY RUNNING TERMINALS, and only a file can say that. Nothing
 * observed here is ever critical — a service an operator deliberately stopped is a fact
 * worth reporting, not a failure, and an exit code that fires on ordinary states is one
 * people stop reading. A separate module keeps that boundary visible rather than
 * re-decided per check.
 *
 * Pure like its sibling: evidence in, findings out, so every `unavailable` reason is
 * assertable without running a subprocess.
 */
import type { SupervisorFinding } from './supervisor-service-audit'
import type { Probe, SupervisorEvidence } from './supervisor-service-probe'

/** One shape for every unreadable probe, so the reason never gets flattened away. */
function unverified<T>(code: string, probe: Probe<T>, subject: string): SupervisorFinding {
  return {
    code,
    severity: 'unverifiable',
    message: `${subject} could not be established: ${
      probe.status === 'unavailable' ? probe.reason : 'no probe ran'
    }`
  }
}

function auditUnitState(evidence: SupervisorEvidence): SupervisorFinding | null {
  const probe = evidence.unitState
  if (!probe) {
    return null
  }
  if (probe.status !== 'observed') {
    return unverified('unit_state_unverified', probe, 'Whether the service is running')
  }
  const { load, active, sub, result, restarts } = probe.value
  // Checked before ActiveState, which reads `inactive` for a unit the supervisor has
  // never loaded — the same answer as a service someone deliberately stopped.
  if (load === 'not-found') {
    return {
      code: 'unit_not_loaded',
      severity: 'warning',
      message:
        'The file is on disk but the supervisor has never loaded it, so nothing is ' +
        'supervising orcad. Placing the file is not the last step.',
      remedy: 'systemctl daemon-reload, then systemctl enable --now <unit>'
    }
  }
  if (load === 'masked') {
    return {
      code: 'unit_masked',
      severity: 'warning',
      message: 'The unit is masked, so it will never start no matter what the file says.',
      remedy: 'systemctl unmask <unit>'
    }
  }
  // A failed unit after exit 78 is the stranding the generated file warns about: it will
  // not come back on its own even once the cause is gone.
  if (active === 'failed') {
    return {
      code: 'unit_failed',
      severity: 'warning',
      message: `Service is failed (${sub}, result=${result}, ${restarts} restarts). Exit 78 leaves it here permanently, including after the cause is fixed.`,
      remedy: 'systemctl reset-failed, then start it again'
    }
  }
  if (active !== 'active') {
    return {
      code: 'unit_inactive',
      severity: 'warning',
      message: `Service is ${active} (${sub}). Deliberate if you stopped it.`
    }
  }
  return { code: 'unit_active', severity: 'ok', message: `Service is active (${sub}).` }
}

function auditLinger(evidence: SupervisorEvidence): SupervisorFinding | null {
  const probe = evidence.linger
  if (!probe) {
    return null
  }
  if (probe.status !== 'observed') {
    return unverified('linger_unverified_live', probe, 'Whether the service survives logout')
  }
  return probe.value
    ? {
        code: 'linger_enabled',
        severity: 'ok',
        message: 'Lingering is enabled: the service survives logout.'
      }
    : {
        code: 'linger_disabled',
        severity: 'warning',
        message:
          'Lingering is disabled, so this user-scope service stops when your last session ends.',
        remedy: 'sudo loginctl enable-linger "$USER"'
      }
}

/**
 * Worded as what was observed. A listener is not proof it is orcad — anything on the host
 * could hold that port, which is exactly the conflict that causes the fallback this check
 * exists to surface.
 */
function auditConfiguredPort(evidence: SupervisorEvidence): SupervisorFinding | null {
  const probe = evidence.configuredPortListening
  if (!probe) {
    return null
  }
  if (probe.status !== 'observed') {
    return unverified('configured_port_unverified', probe, 'Whether the configured port is served')
  }
  if (probe.value) {
    return {
      code: 'configured_port_listening',
      severity: 'ok',
      message: 'Something is listening on the configured port.'
    }
  }
  const active =
    evidence.unitState?.status === 'observed' && evidence.unitState.value.active === 'active'
  return {
    code: 'configured_port_silent',
    severity: 'warning',
    message: active
      ? 'The service is active but nothing is listening on the configured port — a pinned port still falls back to an OS-assigned one on conflict.'
      : 'Nothing is listening on the configured port.',
    remedy: active
      ? 'Check the bound endpoint in the readiness line before relying on an SSH forward.'
      : undefined
  }
}

/**
 * File-level findings that a live answer replaces. Declared here because this module owns
 * the knowledge; the caller matching on code prefixes coupled the two by string shape, and
 * any future `linger*` code would have silently changed which findings got dropped.
 */
export function supersededFileFindingCodes(live: readonly SupervisorFinding[]): string[] {
  const superseded: string[] = []
  if (live.some((finding) => LINGER_CODES.has(finding.code))) {
    superseded.push('linger_unverified')
  }
  return superseded
}

const LINGER_CODES = new Set(['linger_enabled', 'linger_disabled', 'linger_unverified_live'])

export function auditSupervisorEvidence(evidence: SupervisorEvidence): SupervisorFinding[] {
  return [auditUnitState(evidence), auditLinger(evidence), auditConfiguredPort(evidence)].filter(
    (finding): finding is SupervisorFinding => finding !== null
  )
}
