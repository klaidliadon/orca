/**
 * `orca supervisor print|doctor` — a front door over the generator and audit orcad already
 * exposes as `--print-service` and `--doctor`.
 *
 * These inspect and describe THIS machine. The CLI normally targets a paired runtime that
 * is a different host entirely, so `supervisor` is registered in `shouldIgnoreRemoteSelection`
 * and every answer names the host it looked at — otherwise an operator would read a verdict
 * about their laptop as a verdict about their server.
 */
import { hostname } from 'node:os'
import process from 'node:process'
import type { CommandHandler } from '../dispatch'
import { printService, runDoctor } from '../../main/orcad/orcad-service-command'

/** Rebuilds the argv the orcad-side parser expects from the CLI's parsed flag map. */
function toServiceArgv(flags: Map<string, string | boolean>, names: string[]): string[] {
  const argv: string[] = []
  for (const name of names) {
    const value = flags.get(name)
    if (value === true) {
      argv.push(`--${name}`)
    } else if (typeof value === 'string') {
      argv.push(`--${name}`, value)
    }
  }
  return argv
}

export const SUPERVISOR_HANDLERS: Record<string, CommandHandler> = {
  'supervisor print': async ({ flags }) => {
    printService(toServiceArgv(flags, ['scope', 'user', 'node', 'port', 'bind']))
  },
  'supervisor doctor': async ({ flags }) => {
    process.stdout.write(`Inspecting service definitions on ${hostname()} (this machine).\n\n`)
    const code = await runDoctor(toServiceArgv(flags, ['service-path', 'no-probe']))
    if (code !== 0) {
      process.exitCode = code
    }
  }
}
