import { app, type BrowserWindow } from 'electron'

/** Matches the updater deferral in attach-main-window-services.ts. */
export const FIRST_WINDOW_SHOWN_FALLBACK_MS = 15_000

/**
 * Run `task` exactly once, after the first window has painted — never on the pre-window
 * startup path, where blocking the main thread means nothing appears at all.
 *
 * Why a fallback timer as well as the window event: `ready-to-show` never fires when window
 * creation itself fails (a GPU or driver fault), and a task armed only on the happy path
 * would then never run. The timer is unref'd so it cannot hold the process alive.
 *
 * Not for headless hosts: with no window, the fallback is the only path, which moves the task
 * to after readiness has already been advertised.
 */
export function deferUntilFirstWindowShown(
  task: () => void,
  options: { fallbackMs?: number } = {}
): void {
  let done = false
  let fallback: ReturnType<typeof setTimeout> | null = null
  const runOnce = (): void => {
    if (done) {
      return
    }
    done = true
    if (fallback) {
      clearTimeout(fallback)
      fallback = null
    }
    task()
  }
  fallback = setTimeout(runOnce, options.fallbackMs ?? FIRST_WINDOW_SHOWN_FALLBACK_MS)
  fallback.unref?.()
  app.once('browser-window-created', (_event: unknown, window: BrowserWindow) => {
    // Why setImmediate: the reveal handler must return before a blocking task runs, or the
    // paint it is waiting on is the thing being blocked.
    window.once('ready-to-show', () => setImmediate(runOnce))
  })
}
