import type { RedisClient } from "bun"
import type { SecretBox } from "./crypto.js"
import type { Sql } from "./db.js"
import type { Env } from "./env.js"
import type { Logger } from "./log.js"
import type { Realtime } from "./realtime.js"
import type { Limiter } from "./ratelimit.js"

export interface Deps {
  sql: Sql
  redis: RedisClient
  env: Env
  box: SecretBox
  realtime: Realtime
  limiter: Limiter
  log: Logger
  /** Injectable for tests; production uses globalThis.fetch. */
  fetch: typeof fetch
}

export interface Principal {
  userID: string
  username: string
  displayName: string
  accountType: "ADMIN" | "MEMBER"
  sessionID: string
  sessionKind: "web" | "client" | "launcher"
  /** Billing project bound to a client session; undefined for web and Launcher sessions. */
  projectID?: string
  /** Tool a client session serves (one of the 12 catalog ids). */
  toolID?: string
  /** Device a Launcher session runs on. */
  deviceID?: string
}

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 410 | 413 | 422 | 423 | 426 | 429 | 500 | 502 | 503 | 504,
    readonly code: string,
    message: string,
    /**
     * Retry guidance for clients. OpenCode honours `x-should-retry` and `retry-after`, so limits that clear
     * on their own say so, and permanent failures (budget, permissions, configuration) stop retry loops.
     */
    readonly retry: { retryable?: boolean; retryAfterSeconds?: number } = {},
  ) {
    super(message)
  }

  get headers(): Record<string, string> {
    return {
      ...(this.retry.retryable === undefined ? {} : { "x-should-retry": String(this.retry.retryable) }),
      ...(this.retry.retryAfterSeconds === undefined ? {} : { "retry-after": String(this.retry.retryAfterSeconds) }),
    }
  }
}

export type AppEnv = {
  Variables: {
    deps: Deps
    principal: Principal
    requestID: string
  }
}
