import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as MacosTccLoginShell from './macos-tcc-login-shell'

const {
  existsSyncMock,
  statSyncMock,
  accessSyncMock,
  mkdirSyncMock,
  writeFileSyncMock,
  spawnMock,
  prepareMacosTccLoginShellMock,
  resolveAgentForegroundProcessMock,
  readWindowsPtyJobProcessIdsMock,
  killWithDescendantSweepMock,
  isWslAvailableAsyncMock,
  wslUncDirectoryExistsMock,
  createShellPromptReadinessProbeMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  accessSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  prepareMacosTccLoginShellMock: vi.fn(),
  resolveAgentForegroundProcessMock: vi.fn(),
  readWindowsPtyJobProcessIdsMock: vi.fn(),
  killWithDescendantSweepMock: vi.fn(),
  isWslAvailableAsyncMock: vi.fn(),
  wslUncDirectoryExistsMock: vi.fn(),
  createShellPromptReadinessProbeMock: vi.fn()
}))

vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  statSync: statSyncMock,
  accessSync: accessSyncMock,
  mkdirSync: mkdirSyncMock,
  writeFileSync: writeFileSyncMock,
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  constants: { X_OK: 1 }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/orca-user-data')
  }
}))

vi.mock('node-pty', () => ({
  spawn: spawnMock
}))

vi.mock('./macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: prepareMacosTccLoginShellMock
}))

vi.mock('../pty-descendant-termination', () => ({
  killWithDescendantSweep: killWithDescendantSweepMock
}))

const WINDOWS_POWERSHELL_ABS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
vi.mock('./windows-powershell-executable', () => ({
  resolveWindowsPowerShellExecutablePath: () => WINDOWS_POWERSHELL_ABS,
  resolveWindowsPowerShellSpawnChain: () => [WINDOWS_POWERSHELL_ABS],
  getWindowsCmdPath: () => 'C:\\Windows\\System32\\cmd.exe'
}))

vi.mock('./agent-foreground-process', () => ({
  resolveAgentForegroundProcessWithAvailability: (...args: unknown[]) =>
    resolveAgentForegroundProcessMock(...args)
}))

vi.mock('./windows-pty-job-membership', () => ({
  readWindowsPtyJobProcessIds: (...args: unknown[]) => readWindowsPtyJobProcessIdsMock(...args),
  isWindowsPtyJobReadable: () => true
}))

vi.mock('../wsl', () => ({
  parseWslPath: () => null,
  toLinuxPath: (path: string) => path,
  toWindowsWslPath: (path: string) => path,
  getDefaultWslDistro: () => 'Ubuntu',
  isWslAvailableAsync: () => isWslAvailableAsyncMock(),
  wslUncDirectoryExists: (...args: unknown[]) => wslUncDirectoryExistsMock(...args)
}))

vi.mock('../shell-prompt-readiness-probe', () => ({
  createShellPromptReadinessProbe: createShellPromptReadinessProbeMock
}))

import { LocalPtyProvider } from './local-pty-provider'
import {
  applyLocalPtyProviderMockDefaults,
  createLocalPtyMockProcess,
  installLocalPtyProviderEnvSandbox,
  type LocalPtyExitCallback,
  type LocalPtyMockProcess
} from './local-pty-provider-test-harness'

describe('LocalPtyProvider.inspectProcess evidence', () => {
  let provider: LocalPtyProvider
  let mockProc: LocalPtyMockProcess
  let exitCb: LocalPtyExitCallback | undefined

  installLocalPtyProviderEnvSandbox()

  beforeEach(() => {
    applyLocalPtyProviderMockDefaults({
      existsSyncMock,
      statSyncMock,
      accessSyncMock,
      mkdirSyncMock,
      writeFileSyncMock,
      prepareMacosTccLoginShellMock,
      resolveAgentForegroundProcessMock,
      readWindowsPtyJobProcessIdsMock,
      killWithDescendantSweepMock,
      isWslAvailableAsyncMock,
      wslUncDirectoryExistsMock,
      createShellPromptReadinessProbeMock
    })
    exitCb = undefined
    mockProc = createLocalPtyMockProcess({
      get: () => exitCb,
      set: (cb) => {
        exitCb = cb
      }
    })
    spawnMock.mockReturnValue(mockProc)
    provider = new LocalPtyProvider()
  })

  async function recognizeCodex(id: string): Promise<void> {
    resolveAgentForegroundProcessMock.mockResolvedValueOnce({
      available: true,
      processName: 'codex'
    })
    await expect(provider.getForegroundProcess(id)).resolves.toBe('codex')
  }

  it('reports a completed scan as observed evidence', async () => {
    mockProc.process = 'node'
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    resolveAgentForegroundProcessMock.mockResolvedValueOnce({
      available: true,
      processName: 'codex'
    })

    await expect(provider.inspectProcess(id)).resolves.toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: true,
      processEvidence: {
        foreground: { verdict: 'observed', processName: 'codex' },
        children: { verdict: 'live' }
      }
    })
  })

  it('keeps the stable-cache legacy value but marks a degraded scan unverifiable', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    await recognizeCodex(id)

    // The scan degrades and node-pty's title read falls back to the shell.
    mockProc.process = 'zsh'
    resolveAgentForegroundProcessMock.mockResolvedValueOnce({
      available: false,
      processName: 'zsh'
    })

    await expect(provider.inspectProcess(id)).resolves.toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'unverifiable', reason: 'process table scan degraded' },
        children: {
          verdict: 'unverifiable',
          reason: 'pty title matches the shell while the foreground scan is degraded'
        }
      }
    })
  })

  it('marks a thrown foreground inspection unverifiable instead of an exit', async () => {
    const { id } = await provider.spawn({ cols: 80, rows: 24 })
    await recognizeCodex(id)

    mockProc.process = 'zsh'
    resolveAgentForegroundProcessMock.mockRejectedValueOnce(new Error('scan infrastructure died'))

    await expect(provider.inspectProcess(id)).resolves.toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'unverifiable', reason: 'foreground inspection threw' },
        children: {
          verdict: 'unverifiable',
          reason: 'pty title matches the shell while the foreground scan is degraded'
        }
      }
    })
  })

  it('treats a successful Windows job confirmation as an observation', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    mockProc.process = 'powershell.exe'
    const { id } = await provider.spawn({ cols: 80, rows: 24, shellOverride: 'powershell.exe' })

    resolveAgentForegroundProcessMock.mockResolvedValueOnce({
      available: true,
      processName: 'codex',
      processId: 222
    })
    await expect(provider.getForegroundProcess(id)).resolves.toBe('codex')

    // The complete job read proves the anchor pid alive: no scan needed.
    readWindowsPtyJobProcessIdsMock.mockReturnValue(new Set([mockProc.pid, 222]))
    const scanCallsBefore = resolveAgentForegroundProcessMock.mock.calls.length

    await expect(provider.inspectProcess(id)).resolves.toEqual({
      foregroundProcess: 'codex',
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'observed', processName: 'codex' },
        // Legacy false collapse: the shell title hides the agent on Windows,
        // but the observed foreground outranks the stale title.
        children: { verdict: 'live' }
      }
    })
    expect(resolveAgentForegroundProcessMock.mock.calls.length).toBe(scanCallsBefore)
  })
})
