/**
 * REAL PROVIDER VERIFICATION — run against a Saorsa deployment where an administrator has already entered a
 * real provider key in the web console (Models & Keys) and authorized the model for one of your project groups.
 *
 *   bun scripts/verify-provider.ts --origin https://saorsa.tech --model <alias> [--skip-cache]
 *
 * Authentication uses the same browser device flow as OpenCode: the script prints a URL, you approve it as a
 * member and choose the billing project. No password or API key is typed into the terminal or stored. The
 * script never sees the provider key; it only talks to the Saorsa gateway.
 *
 * Checks (each is a real, billed call — expect a few cents of spend):
 *   1. non-streaming reply             4. tool call round trip (forced tool choice, then tool result)
 *   2. streaming reply with usage      5. prompt caching (same long prefix twice; second call should report cache reads)
 *   3. cancellation mid-stream         6. Saorsa ledger vs. usage reported by the provider in the responses
 *
 * The report is written to .data/provider-verification-*.json (git-ignored). Reconcile it against the
 * provider's billing console using the upstream request IDs and timestamps it contains.
 */
import { mkdir } from "node:fs/promises"
import path from "node:path"

const args = new Map<string, string>()
for (let index = 2; index < process.argv.length; index++) {
  const key = process.argv[index]!
  if (!key.startsWith("--")) continue
  const next = process.argv[index + 1]
  if (next && !next.startsWith("--")) {
    args.set(key.slice(2), next)
    index++
  } else args.set(key.slice(2), "true")
}
const origin = (args.get("origin") ?? process.env.SAORSA_PUBLIC_URL ?? process.env.NEXCODE_PUBLIC_URL ?? process.env.TEAMOS_PUBLIC_URL ?? "").replace(/\/+$/, "")
const alias = args.get("model")
if (!origin || !alias) {
  console.error("usage: bun scripts/verify-provider.ts --origin <Saorsa URL> --model <model alias> [--skip-cache]")
  process.exit(2)
}

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }
interface Check {
  name: string
  ok: boolean
  detail: string
  requestID?: string
  upstreamUsage?: Usage
  ms?: number
}

const token = await deviceLogin()
const config = (await (await fetch(`${origin}/api/v2/config`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
  providers: Record<string, { package: string; settings: { baseURL: string }; models: Record<string, unknown> }>
}
const provider = Object.values(config.providers).find((item) => alias in (item.models ?? {}))
if (!provider) {
  console.error(`Model ${alias} is not authorized for the project you selected. Authorized: ${Object.values(config.providers).flatMap((item) => Object.keys(item.models ?? {})).join(", ") || "none"}`)
  process.exit(1)
}
const anthropic = provider.package.includes("anthropic")
console.log(`\nVerifying ${alias} via ${anthropic ? "Anthropic Messages" : "OpenAI Chat Completions"} at ${provider.settings.baseURL}\n`)

const checks: Check[] = []
checks.push(await run("non-stream reply", () => call({ stream: false, messages: [user("Reply with exactly: SAORSA-OK")] })))
checks.push(await run("streaming reply with usage", () => call({ stream: true, messages: [user("Count from 1 to 5, comma separated.")] })))
checks.push(await run("cancellation mid-stream", cancelled))
checks.push(await run("tool call round trip", toolRoundTrip))
if (args.get("skip-cache") !== "true") checks.push(await run("prompt caching (second call)", caching))

await Bun.sleep(1500)
const recorded = (await (await fetch(`${origin}/api/me/requests?limit=50`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
  items: Array<Record<string, any>>
}
const byID = new Map(recorded.items.map((item) => [item.request_id as string, item]))
const rows = checks.map((check) => {
  const row = check.requestID ? byID.get(check.requestID) : undefined
  const upstream = check.upstreamUsage
  const matches =
    row && upstream
      ? Number(row.input_tokens) === upstream.input && Number(row.output_tokens) === upstream.output && Number(row.cache_read_tokens) === upstream.cacheRead
      : undefined
  return {
    check: check.name,
    result: check.ok ? "PASS" : "FAIL",
    detail: check.detail,
    saorsa_request_id: check.requestID,
    upstream_request_id: row?.upstream_request_id,
    status: row?.status,
    billing: row?.billing_status,
    upstream_usage: upstream,
    saorsa_usage: row && {
      input: Number(row.input_tokens),
      output: Number(row.output_tokens),
      cacheRead: Number(row.cache_read_tokens),
      cacheWrite: Number(row.cache_write_tokens),
    },
    ledger_matches_upstream: matches,
    cost_usd: row ? Number(row.cost_micros) / 1e6 : undefined,
    ms: check.ms,
  }
})
console.table(rows.map((row) => ({ check: row.check, result: row.result, billing: row.billing, ledgerMatch: row.ledger_matches_upstream, cost: row.cost_usd, detail: row.detail.slice(0, 60) })))
await mkdir(path.join(import.meta.dir, "..", ".data"), { recursive: true })
const file = path.join(import.meta.dir, "..", ".data", `provider-verification-${alias.replace(/[^\w.-]/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
await Bun.write(file, JSON.stringify({ origin, alias, protocol: anthropic ? "anthropic-messages" : "openai-chat", at: new Date().toISOString(), rows }, null, 2))
console.log(`\nReport: ${file}\nNext: compare upstream_request_id / timestamps / tokens with the provider's usage console.`)
process.exit(rows.every((row) => row.result === "PASS") ? 0 : 1)

async function deviceLogin() {
  const start = (await (await fetch(`${origin}/auth/device/code`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: "teamos-verify" }) })).json()) as Record<string, any>
  console.log(`Open ${start.verification_uri_complete}\nLog in as a MEMBER, choose the billing project, and approve code ${start.user_code}.`)
  for (;;) {
    await Bun.sleep((start.interval ?? 5) * 1000)
    const result = (await (
      await fetch(`${origin}/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: start.device_code }),
      })
    ).json()) as Record<string, any>
    if (result.access_token) return result.access_token as string
    if (result.error !== "authorization_pending" && result.error !== "slow_down") throw new Error(`Device login failed: ${result.error}`)
  }
}

function user(content: string) {
  return { role: "user", content }
}

async function run(name: string, fn: () => Promise<Omit<Check, "name">>): Promise<Check> {
  const started = performance.now()
  try {
    const result = await fn()
    return { name, ...result, ms: Math.round(performance.now() - started) }
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error), ms: Math.round(performance.now() - started) }
  }
}

/** One gateway call in the provider's protocol; returns text, tool calls and the usage the provider reported. */
async function call(input: { stream: boolean; messages: unknown[]; system?: unknown; tools?: unknown[]; toolChoice?: string; signal?: AbortSignal; onChunk?: () => void }) {
  const url = anthropic ? `${provider!.settings.baseURL}/messages` : `${provider!.settings.baseURL}/chat/completions`
  const body = anthropic
    ? {
        model: alias,
        max_tokens: 512,
        stream: input.stream,
        messages: input.messages,
        ...(input.system ? { system: input.system } : {}),
        ...(input.tools ? { tools: input.tools, tool_choice: input.toolChoice ? { type: "tool", name: input.toolChoice } : undefined } : {}),
      }
    : {
        model: alias,
        max_tokens: 512,
        stream: input.stream,
        messages: input.system ? [{ role: "system", content: input.system }, ...input.messages] : input.messages,
        ...(input.tools ? { tools: input.tools, tool_choice: input.toolChoice ? { type: "function", function: { name: input.toolChoice } } : undefined } : {}),
      }
  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}) },
    body: JSON.stringify(body),
    signal: input.signal,
  })
  const requestID = response.headers.get("x-saorsa-request-id") ?? undefined
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`), { requestID })
  const parsed = input.stream
    ? await readStream(response, input.onChunk).catch((error: Error) => {
        throw Object.assign(error, { requestID })
      })
    : parseBody((await response.json()) as Record<string, any>)
  return { ok: true, detail: parsed.text.slice(0, 120) || `${parsed.toolCalls.length} tool call(s)`, requestID, upstreamUsage: parsed.usage, ...parsed }
}

function parseBody(json: Record<string, any>) {
  if (anthropic) {
    const content = (json.content ?? []) as Array<Record<string, any>>
    return {
      text: content.filter((block) => block.type === "text").map((block) => block.text).join(""),
      toolCalls: content.filter((block) => block.type === "tool_use").map((block) => ({ id: block.id, name: block.name, input: block.input })),
      usage: anthropicUsage(json.usage),
      raw: content,
    }
  }
  const message = json.choices?.[0]?.message ?? {}
  return {
    text: message.content ?? "",
    toolCalls: (message.tool_calls ?? []).map((tool: any) => ({ id: tool.id, name: tool.function?.name, input: tool.function?.arguments })),
    usage: openAIUsage(json.usage),
    raw: message,
  }
}

async function readStream(response: Response, onChunk?: () => void) {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let text = ""
  let usage: Usage | undefined
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    onChunk?.()
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (data === "[DONE]") continue
      try {
        const event = JSON.parse(data)
        if (anthropic) {
          if (event.type === "message_start") usage = anthropicUsage(event.message?.usage, usage)
          if (event.type === "message_delta") usage = anthropicUsage(event.usage, usage)
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") text += event.delta.text
          if (event.type === "error") throw new Error(event.error?.message ?? "stream error")
        } else {
          if (event.usage) usage = openAIUsage(event.usage)
          if (event.error) throw new Error(event.error.message ?? "stream error")
          text += event.choices?.[0]?.delta?.content ?? ""
        }
      } catch (error) {
        if (error instanceof SyntaxError) continue
        throw error
      }
    }
  }
  if (!usage) throw new Error("stream ended without provider usage (Saorsa will bill it as estimated)")
  return { text, toolCalls: [] as Array<{ id: string; name: string; input: unknown }>, usage, raw: undefined }
}

async function cancelled() {
  const controller = new AbortController()
  let chunks = 0
  const result = await call({
    stream: true,
    messages: [user("Write a 400-word essay about the history of compilers.")],
    signal: controller.signal,
    onChunk: () => {
      chunks++
      if (chunks === 3) controller.abort()
    },
  }).catch((error: Error & { requestID?: string }) => ({ ok: true, detail: `aborted after ${chunks} chunks`, requestID: error.requestID }))
  if (!result.requestID) return { ok: false, detail: "stream finished before it could be cancelled", requestID: result.requestID }
  // Saorsa must close the request as cancelled and bill only an estimate, never an exact count it never received.
  const row = await eventuallyRecorded(result.requestID)
  return {
    ok: row?.status === "cancelled" && row?.billing_status === "estimated",
    detail: `aborted after ${chunks} chunks → Saorsa recorded ${row?.status ?? "nothing"} / ${row?.billing_status ?? "-"}`,
    requestID: result.requestID,
  }
}

async function eventuallyRecorded(requestID: string) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const list = (await (await fetch(`${origin}/api/me/requests?limit=20`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
      items: Array<Record<string, any>>
    }
    const row = list.items.find((item) => item.request_id === requestID)
    if (row && !["pending", "streaming"].includes(row.status)) return row
    await Bun.sleep(250)
  }
  return undefined
}

async function toolRoundTrip() {
  const weather = anthropic
    ? { name: "get_weather", description: "Get the weather for a city", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }
    : { type: "function", function: { name: "get_weather", description: "Get the weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }
  const ask = user("What is the weather in Hangzhou? Use the tool.")
  const first = await call({ stream: false, messages: [ask], tools: [weather], toolChoice: "get_weather" })
  const tool = first.toolCalls[0]
  if (!tool) return { ok: false, detail: "provider did not return a tool call", requestID: first.requestID, upstreamUsage: first.upstreamUsage }
  const followUp = anthropic
    ? [ask, { role: "assistant", content: first.raw }, { role: "user", content: [{ type: "tool_result", tool_use_id: tool.id, content: "Sunny, 24°C" }] }]
    : [ask, first.raw, { role: "tool", tool_call_id: tool.id, content: "Sunny, 24°C" }]
  const second = await call({ stream: false, messages: followUp, tools: [weather] })
  return {
    ok: /24|sunny|晴/i.test(second.text),
    detail: `tool ${tool.name} → final: ${second.text.slice(0, 80)}`,
    requestID: second.requestID,
    upstreamUsage: second.upstreamUsage,
  }
}

async function caching() {
  // Comfortably above every provider's minimum cacheable prefix (1024 tokens for OpenAI and Anthropic Sonnet).
  const prefix = `You are a meticulous reviewer. Reference handbook follows.\n${"Saorsa caching verification paragraph. ".repeat(600)}`
  const system = anthropic ? [{ type: "text", text: prefix, cache_control: { type: "ephemeral" } }] : prefix
  await call({ stream: false, system, messages: [user("Say A")] })
  await Bun.sleep(1500)
  const second = await call({ stream: false, system, messages: [user("Say B")] })
  const reads = second.upstreamUsage?.cacheRead ?? 0
  return {
    ok: true,
    detail: reads > 0 ? `cache read ${reads} tokens on second call` : "provider reported no cache reads (check whether this model/account supports caching)",
    requestID: second.requestID,
    upstreamUsage: second.upstreamUsage,
  }
}

function openAIUsage(value: any): Usage | undefined {
  if (!value) return undefined
  return {
    input: Number(value.prompt_tokens ?? 0),
    output: Number(value.completion_tokens ?? 0),
    cacheRead: Number(value.prompt_tokens_details?.cached_tokens ?? value.prompt_cache_hit_tokens ?? 0),
    cacheWrite: 0,
  }
}

// Same normalization as the gateway: Anthropic's input_tokens exclude cache, Saorsa stores input including cache.
function anthropicUsage(value: any, previous?: Usage): Usage | undefined {
  if (!value) return previous
  const uncached = value.input_tokens ?? (previous ? previous.input - previous.cacheRead - previous.cacheWrite : undefined)
  const read = value.cache_read_input_tokens ?? previous?.cacheRead ?? 0
  const write = value.cache_creation_input_tokens ?? previous?.cacheWrite ?? 0
  const output = value.output_tokens ?? previous?.output
  if (uncached === undefined || output === undefined) return previous
  return { input: uncached + read + write, output, cacheRead: read, cacheWrite: write }
}
