import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { AppEnv } from "../context.js"
import type { RealtimeEvent } from "../realtime.js"

const MAX_STREAMS_PER_USER = 5
const open = new Map<string, number>()

/** Authenticated, filtered SSE stream. Clients reload state from the REST API on (re)connect. */
export function sseStream(c: Context<AppEnv>, allow: (event: RealtimeEvent) => boolean) {
  const principal = c.get("principal")
  const count = open.get(principal.userID) ?? 0
  if (count >= MAX_STREAMS_PER_USER) return c.json({ error: { code: "too_many_streams", message: "Too many open event streams" } }, 429)
  open.set(principal.userID, count + 1)
  return streamSSE(c, async (stream) => {
    const queue: RealtimeEvent[] = []
    let wake: (() => void) | undefined
    let ended = false
    const unlisten = c.get("deps").realtime.listen((event) => {
      // A login on another device ends this session: tell the console, then close the stream.
      if (event.type === "session.ended") {
        if (event.userID !== principal.userID || !(event.data.sessionIDs as string[]).includes(principal.sessionID)) return
        ended = true
      } else if (!allow(event)) return
      queue.push(event)
      wake?.()
    })
    stream.onAbort(() => wake?.())
    try {
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ at: new Date().toISOString() }) })
      while (!stream.aborted) {
        const next = queue.shift()
        if (next) {
          await stream.writeSSE({ event: next.type, data: JSON.stringify(next) })
          if (ended && next.type === "session.ended") break
          continue
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          setTimeout(resolve, 20_000)
        })
        wake = undefined
        if (queue.length === 0 && !stream.aborted) await stream.writeSSE({ event: "ping", data: "{}" })
      }
    } finally {
      unlisten()
      open.set(principal.userID, Math.max(0, (open.get(principal.userID) ?? 1) - 1))
    }
  })
}
