import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { paths } from "./paths.js"

// Saorsa tokens, common provider key shapes and bearer headers never reach the log file.
const SECRETS = [
  /\btos_(?:at|rt|dc|web)_[A-Za-z0-9_-]{10,}/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /(authorization|x-api-key|x-goog-api-key)\s*[:=]\s*(?:bearer\s+)?\S+/gi,
]

export function redact(text: string) {
  return SECRETS.reduce((value, pattern) => value.replace(pattern, (match) => (/^[a-z-]+\s*[:=]/i.test(match) ? match.replace(/\s*[:=][\s\S]*$/, ": [redacted]") : "[redacted]")), text)
}

/** Append-only local diagnostic log; the content is redacted before it is written. */
export async function log(event: string, fields: Record<string, unknown> = {}) {
  const file = paths.log()
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `${redact(JSON.stringify({ at: new Date().toISOString(), event, ...fields }))}\n`, { mode: 0o600 })
}
