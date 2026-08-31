import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * orcad has no renderer and no Electron startup services, so what makes its terminals and its
 * agent chat work is a handful of single calls in one function. Each was missing once and none
 * failed loudly — a missing graph sentinel answers `runtime_unavailable`, unwired hook seams
 * answer empty. Pin them in source, the way the serve host's are pinned.
 */
const source = readFileSync(join(process.cwd(), 'src/main/orcad/orcad-entry.ts'), 'utf8')

describe('orcad headless startup wiring', () => {
  it('publishes the headless graph sentinel after PTY registration and before RPC', () => {
    const registration = source.indexOf('await registerHeadlessPtyRuntime(')
    const sentinel = source.indexOf(
      'runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID',
      registration
    )
    const rpc = source.indexOf('new OrcaRuntimeRpcServer(', sentinel)

    expect(registration).toBeGreaterThanOrEqual(0)
    expect(sentinel).toBeGreaterThan(registration)
    expect(rpc).toBeGreaterThan(sentinel)
    // The named constant, never the literal it happens to equal.
    expect(source).not.toContain('runtime.syncWindowGraph(0,')
  })

  it('starts the agent hook server before anything can spawn a PTY with a frozen env', () => {
    const hookServer = source.indexOf('await agentHookServer.start(')
    const daemon = source.indexOf('await startOrcadDaemon()', hookServer)
    const registration = source.indexOf('await registerHeadlessPtyRuntime(', daemon)

    expect(hookServer).toBeGreaterThanOrEqual(0)
    expect(daemon).toBeGreaterThan(hookServer)
    expect(registration).toBeGreaterThan(daemon)
  })

  it('reads hook status back into the runtime instead of only writing it', () => {
    const runtime = source.indexOf('new OrcaRuntimeService(')
    const deps = source.slice(runtime, source.indexOf('\n  })', runtime))

    expect(runtime).toBeGreaterThanOrEqual(0)
    // Without these the started server collects rows nothing reads: no transcript address
    // for native chat, and Claude resume refuses for want of a provider-session observation.
    for (const seam of [
      'onTerminalAgentStatus:',
      'getAgentStatusSnapshot:',
      'getAgentProviderSessionSnapshot:',
      'getAgentProviderSessionRowsForPane:',
      'attestAgentHookCompatibilityAuthority:',
      'retireAgentHookCompatibilityAuthority:',
      'reconcileAgentStatusForEndedProcess:'
    ]) {
      expect(deps).toContain(seam)
    }
  })

  it('stops the hook server on teardown and on a failed launch', () => {
    const hookServer = source.indexOf('await agentHookServer.start(')
    const armed = source.indexOf('stopOrcadAgentHookServer = () => agentHookServer.stop()')
    // Why the arming matters: startOrcad's failure path never imports the server, and a
    // listener left bound makes start()'s early return hand the next attempt a stale token.
    const failurePath = source.indexOf('return await startOrcadRuntime(')

    expect(armed).toBeGreaterThan(hookServer)
    expect(source.indexOf('stopOrcadAgentHookServer()', failurePath)).toBeGreaterThan(failurePath)
    expect(source.indexOf('agentHookServer.stop()', failurePath)).toBeGreaterThan(failurePath)
  })
})
