import { redactValue } from "./redact.js"

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const
export type Level = keyof typeof levels

export function createLogger(min: Level) {
  const write = (level: Level, message: string, fields?: Record<string, unknown>) => {
    if (levels[level] < levels[min]) return
    // Structured JSON lines; every field passes through the redactor so keys and tokens never reach logs.
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...(redactValue(fields ?? {}) as object) })
    if (level === "error" || level === "warn") console.error(line)
    else console.log(line)
  }
  return {
    debug: (message: string, fields?: Record<string, unknown>) => write("debug", message, fields),
    info: (message: string, fields?: Record<string, unknown>) => write("info", message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => write("warn", message, fields),
    error: (message: string, fields?: Record<string, unknown>) => write("error", message, fields),
  }
}

export type Logger = ReturnType<typeof createLogger>
