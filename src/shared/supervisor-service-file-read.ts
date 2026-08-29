/**
 * Reading values back out of an installed supervisor service definition.
 *
 * Deliberately not an XML or INI parser: the audit must work on a hand-edited file that a
 * strict parser would reject outright, since a hand-edited file is exactly the one most
 * likely to be wrong.
 */
import type { SupervisorPlatform, SupervisorScope } from './supervisor-service-render'

export type SupervisorServiceFile = {
  path: string
  text: string
  platform: SupervisorPlatform
  scope: SupervisorScope
}

/** systemd `Key=value`, ignoring comments. Last assignment wins, as systemd itself does. */
export function readSystemdKey(text: string, key: string): string | null {
  let found: string | null = null
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#') || line.startsWith(';')) {
      continue
    }
    const match = new RegExp(`^${key}\\s*=\\s*(.*)$`).exec(line)
    if (match) {
      found = match[1].trim()
    }
  }
  return found
}

/**
 * `<key>Name</key>` followed by its value element. Deliberately not an XML parser: the
 * audit must work on a hand-edited plist that a strict parser would reject outright.
 */
export function readPlistBoolean(text: string, key: string): boolean | null {
  const match = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<(true|false)\\s*/>`, 'i').exec(text)
  return match ? match[1].toLowerCase() === 'true' : null
}

export function readPlistString(text: string, key: string): string | null {
  const match = new RegExp(`<key>\\s*${key}\\s*</key>\\s*<string>([^<]*)</string>`, 'i').exec(text)
  return match ? match[1].trim() : null
}

/** systemd writes `Environment=NAME=value`; the plist nests it under EnvironmentVariables. */
export function readPinnedUserData(file: SupervisorServiceFile): string | null {
  if (file.platform === 'systemd') {
    for (const raw of file.text.split('\n')) {
      const line = raw.trim()
      if (line.startsWith('#')) {
        continue
      }
      const match = /^Environment\s*=\s*"?ORCA_USER_DATA=([^"]*)"?$/.exec(line)
      if (match) {
        return match[1].trim()
      }
    }
    return null
  }
  const dict = /<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/i.exec(file.text)
  return dict ? readPlistString(dict[1], 'ORCA_USER_DATA') : null
}

/**
 * The endpoint the service will actually try to bind, read from the file rather than from
 * the caller's flags — probing a default port while the file names another one reports the
 * wrong answer with full confidence.
 */
export function readConfiguredEndpoint(
  file: SupervisorServiceFile
): { bind: string; port: number } | null {
  // Why scoped to ProgramArguments and not every <string> in the plist: the data root and
  // log path are strings too, and joining them all lets an unrelated value supply the port.
  const programArguments = /<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/i.exec(
    file.text
  )?.[1]
  const command =
    file.platform === 'systemd'
      ? (readSystemdKey(file.text, 'ExecStart') ?? '')
      : [...(programArguments ?? '').matchAll(/<string>([^<]*)<\/string>/g)]
          .map((match) => match[1])
          .join(' ')
  const port = Number(/--port[\s=]+(\d+)/.exec(command)?.[1])
  if (!Number.isInteger(port)) {
    return null
  }
  return { bind: /--bind[\s=]+(\S+)/.exec(command)?.[1] ?? '127.0.0.1', port }
}
