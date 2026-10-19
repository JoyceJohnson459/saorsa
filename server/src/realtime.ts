import type { RedisClient } from "bun"
import type { Logger } from "./log.js"

export interface RealtimeEvent {
  type: string
  /** Owner of the event. Member streams only ever receive events whose userID is the member. */
  userID?: string
  projectID?: string
  data: Record<string, unknown>
  at: string
}

type Listener = (event: RealtimeEvent) => void

const CHANNEL = "teamos:events"

/**
 * Fan-out for SSE. Redis pub/sub carries events between replicas; each replica delivers to its own
 * subscribers. SSE is a convenience channel only: dashboards reload from the database on (re)connect.
 */
export async function createRealtime(redis: RedisClient, log: Logger) {
  const listeners = new Set<Listener>()
  const subscriber = await redis.duplicate()
  await subscriber.subscribe(CHANNEL, (message) => {
    const parsed = parse(message)
    if (!parsed) return
    for (const listener of listeners) listener(parsed)
  })
  return {
    publish: async (event: Omit<RealtimeEvent, "at">) => {
      await redis.publish(CHANNEL, JSON.stringify({ ...event, at: new Date().toISOString() })).catch((cause) => {
        log.warn("realtime publish failed", { cause: String(cause) })
      })
    },
    listen: (listener: Listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    close: () => subscriber.close(),
  }
}

export type Realtime = Awaited<ReturnType<typeof createRealtime>>

function parse(message: string): RealtimeEvent | undefined {
  try {
    return JSON.parse(message) as RealtimeEvent
  } catch {
    return undefined
  }
}
