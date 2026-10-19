import type { RedisClient } from "bun"
import { ApiError } from "./context.js"

/**
 * Distributed limits, each enforced by one atomic Lua script so concurrent gateway replicas can never
 * jointly overshoot:
 * - requests and tokens per minute: sliding-window counters (current bucket + decayed previous bucket);
 * - concurrency: a lease semaphore (sorted set scored by lease expiry), so a crashed replica's slots
 *   free themselves instead of leaking, and long streams renew their lease while they run.
 * All keys share the `{teamos}` hash tag so multi-key scripts also work on Redis Cluster.
 */

const WINDOW_MS = 60_000
const PREFIX = "{teamos}"

const SLIDING_WINDOW = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local n = tonumber(ARGV[3])
local elapsed = now % window
local weight = (window - elapsed) / window
for i = 1, n do
  local limit = tonumber(ARGV[2 + 2 * i])
  local cost = tonumber(ARGV[3 + 2 * i])
  local current = tonumber(redis.call('GET', KEYS[2 * i - 1]) or '0')
  local previous = tonumber(redis.call('GET', KEYS[2 * i]) or '0')
  local used = math.floor(previous * weight) + current
  if used + cost > limit then
    return {i, used, window - elapsed}
  end
end
for i = 1, n do
  local cost = tonumber(ARGV[3 + 2 * i])
  if cost > 0 then
    redis.call('INCRBY', KEYS[2 * i - 1], cost)
    redis.call('PEXPIRE', KEYS[2 * i - 1], window * 2)
  end
end
return {0, 0, 0}
`

const SEMAPHORE_ACQUIRE = `
local now = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
local member = ARGV[3]
for i = 1, #KEYS do
  redis.call('ZREMRANGEBYSCORE', KEYS[i], '-inf', now)
  if redis.call('ZCARD', KEYS[i]) >= tonumber(ARGV[3 + i]) then
    return i
  end
end
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], now + lease, member)
  redis.call('PEXPIRE', KEYS[i], lease * 2)
end
return 0
`

const SEMAPHORE_RENEW = `
local expiry = tonumber(ARGV[1])
local member = ARGV[2]
for i = 1, #KEYS do
  redis.call('ZADD', KEYS[i], 'XX', expiry, member)
  redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[3]))
end
return 0
`

export interface WindowLimit {
  /** Stable scope key, e.g. "user:<uuid>" or "provider:<uuid>". */
  scope: string
  limit: number
  /** Human wording for errors, e.g. "your requests per minute". */
  label: string
}

export interface SlotLimit {
  scope: string
  limit: number
  label: string
  code: "concurrency_limited" | "model_busy" | "provider_busy"
}

/** Tokens admitted for one request, so the bucket can be corrected once the real usage is known. */
export interface TokenTicket {
  keys: string[]
  estimate: number
  /** Set once corrected, so an error path after settlement cannot correct the bucket a second time. */
  settled?: boolean
}

export function createLimiter(redis: RedisClient) {
  const evalScript = (script: string, keys: string[], args: Array<string | number>) =>
    redis.send("EVAL", [script, String(keys.length), ...keys, ...args.map(String)]) as Promise<unknown>

  const bucketKeys = (scope: string, metric: "req" | "tok", now: number) => {
    const bucket = Math.floor(now / WINDOW_MS)
    return [`${PREFIX}:rl:${metric}:${scope}:${bucket}`, `${PREFIX}:rl:${metric}:${scope}:${bucket - 1}`]
  }

  const recordRejection = async (reason: string) => {
    const key = `${PREFIX}:metrics:rejected:${reason}:${Math.floor(Date.now() / 60_000)}`
    await redis.send("INCR", [key])
    await redis.send("EXPIRE", [key, "7200"])
  }

  /**
   * Checks request and token windows together and only then charges all of them, so a request rejected by
   * one scope never consumes another scope's budget. Tokens use the input estimate at admission; output is
   * added when the request settles (see adjust).
   */
  const admit = async (input: { requests: WindowLimit[]; tokens: WindowLimit[]; estimatedTokens: number; now?: number }) => {
    const now = input.now ?? Date.now()
    for (const limit of input.tokens)
      if (input.estimatedTokens > limit.limit) {
        await recordRejection("tokens_per_minute")
        throw new ApiError(
          413,
          "request_exceeds_token_rate",
          `This request (~${input.estimatedTokens} input tokens) is larger than ${limit.label} (${limit.limit}). Reduce the context or ask an administrator to raise the limit.`,
          { retryable: false },
        )
      }
    const limits = [
      ...input.requests.map((limit) => ({ limit, metric: "req" as const, cost: 1 })),
      ...input.tokens.map((limit) => ({ limit, metric: "tok" as const, cost: input.estimatedTokens })),
    ]
    if (limits.length === 0) return { keys: [], estimate: 0 }
    const keys = limits.flatMap((item) => bucketKeys(item.limit.scope, item.metric, now))
    const args = [now, WINDOW_MS, limits.length, ...limits.flatMap((item) => [item.limit.limit, item.cost])]
    const [index, used, retryMs] = (await evalScript(SLIDING_WINDOW, keys, args)) as [number, number, number]
    if (index !== 0) {
      const failed = limits[index - 1]!
      await recordRejection(failed.metric === "req" ? "requests_per_minute" : "tokens_per_minute")
      throw new ApiError(
        429,
        "rate_limited",
        `Rate limit reached: ${failed.limit.label} is ${failed.limit.limit} ${failed.metric === "req" ? "requests" : "tokens"} per minute (${used} used). Retrying automatically shortly.`,
        { retryable: true, retryAfterSeconds: Math.max(1, Math.ceil(retryMs / 1000)) },
      )
    }
    return {
      keys: limits.flatMap((item, position) => (item.metric === "tok" ? [keys[position * 2]!] : [])),
      estimate: input.estimatedTokens,
    } satisfies TokenTicket
  }

  /** Replaces the admission estimate with the actual input+output tokens in the admission bucket. */
  const adjust = async (ticket: TokenTicket, actualTokens: number) => {
    if (ticket.settled) return
    ticket.settled = true
    const delta = Math.round(actualTokens - ticket.estimate)
    if (delta === 0) return
    for (const key of ticket.keys) {
      await redis.send("INCRBY", [key, String(delta)])
      await redis.send("PEXPIRE", [key, String(WINDOW_MS * 2)])
    }
  }

  /** Acquires every slot or none. The returned lease must be renewed for long streams and released at the end. */
  const acquire = async (slots: SlotLimit[], member: string, leaseMs = 120_000) => {
    const keys = slots.map((slot) => `${PREFIX}:cc:${slot.scope}`)
    if (keys.length) {
      const failed = Number(await evalScript(SEMAPHORE_ACQUIRE, keys, [Date.now(), leaseMs, member, ...slots.map((slot) => slot.limit)]))
      if (failed !== 0) {
        const slot = slots[failed - 1]!
        await recordRejection(slot.code)
        throw new ApiError(429, slot.code, `Too many concurrent requests: ${slot.label} is ${slot.limit}. Retrying automatically shortly.`, {
          retryable: true,
          retryAfterSeconds: 2,
        })
      }
    }
    let released = false
    const timer = keys.length
      ? setInterval(() => {
          void evalScript(SEMAPHORE_RENEW, keys, [Date.now() + leaseMs, member, leaseMs * 2]).catch(() => {})
        }, leaseMs / 3)
      : undefined
    return {
      release: async () => {
        if (released) return
        released = true
        clearInterval(timer)
        for (const key of keys) await redis.send("ZREM", [key, member])
      },
    }
  }

  /** Rejections per reason over the last `minutes` minutes, for the admin gateway status page. */
  const rejections = async (minutes = 60) => {
    const current = Math.floor(Date.now() / 60_000)
    const reasons = ["requests_per_minute", "tokens_per_minute", "concurrency_limited", "model_busy", "provider_busy"]
    const result: Record<string, number> = {}
    for (const reason of reasons) {
      const keys = Array.from({ length: minutes }, (_, offset) => `${PREFIX}:metrics:rejected:${reason}:${current - offset}`)
      const values = (await redis.send("MGET", keys)) as Array<string | null>
      result[reason] = values.reduce((sum, value) => sum + Number(value ?? 0), 0)
    }
    return result
  }

  /** Current in-flight count for a concurrency scope (expired leases excluded). */
  const inFlight = async (scope: string) => Number(await redis.send("ZCOUNT", [`${PREFIX}:cc:${scope}`, String(Date.now()), "+inf"]))

  return { admit, adjust, acquire, rejections, inFlight }
}

export type Limiter = ReturnType<typeof createLimiter>
