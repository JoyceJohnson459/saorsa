import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { MOCK_KEY } from "../src/mock-upstream.js"
import { anthropicUsage } from "../src/protocols.js"
import { BOOTSTRAP_TOKEN, deviceLogin, eventually, startHarness, webClient, type Harness, type WebClient } from "./harness.js"

// Anthropic Messages path of the gateway, against real PostgreSQL + Redis and the TEST-labelled mock upstream.
// It must behave like the OpenAI path (attribution, budgets, ledger, risk) while speaking Anthropic's wire format.

let h: Harness
let admin: WebClient
let token = ""
const ids = {} as Record<string, string>

const messages = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${h.origin}/gateway/anthropic/v1/messages`, {
    method: "POST",
    // Stock OpenCode sends the Saorsa OAuth token as a bearer authToken for the Anthropic package.
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "anthropic-version": "2023-06-01", ...headers },
    body: JSON.stringify(body),
  })

const lastRequest = () =>
  eventually(
    async () => (await h.sql`select * from gateway_requests order by started_at desc limit 1`)[0],
    (row) => row && !["pending", "streaming"].includes(row.status),
  )

beforeAll(async () => {
  h = await startHarness()
  admin = webClient(h.origin)
  const password = "Adm1n!Strong-Passphrase"
  await admin.post("/api/auth/bootstrap", { token: BOOTSTRAP_TOKEN, organization: "Claude Org", username: "root-admin", displayName: "Root", password })
  await admin.login("root-admin", password)
  await admin.patch("/api/admin/settings", { keyAssignment: "shared", singleDeviceLogin: false })
  ids.project = (await admin.post("/api/admin/projects", { code: "CLAUDE", name: "Claude Project", purpose: "inference service refactoring" })).json.id
  const member = await admin.post("/api/admin/users", { username: "dev-one", displayName: "Dev One", password: "Zx9!Correct-Horse-1", projectIDs: [ids.project] })
  ids.member = member.json.id
  ids.anthropic = (await admin.post("/api/admin/providers", { name: "Mock Anthropic (TEST)", protocol: "anthropic-messages", baseURL: h.mock.url })).json.id
  await admin.post(`/api/admin/providers/${ids.anthropic}/credentials`, { label: "primary", apiKey: MOCK_KEY })
  ids.openai = (await admin.post("/api/admin/providers", { name: "Mock OpenAI (TEST)", protocol: "openai-chat", baseURL: h.mock.url })).json.id
  await admin.post(`/api/admin/providers/${ids.openai}/credentials`, { label: "primary", apiKey: MOCK_KEY })
  ids.claude = (
    await admin.post("/api/admin/models", {
      providerID: ids.anthropic,
      upstreamModel: "mock-claude-upstream",
      alias: "mock-claude",
      displayName: "Mock Claude",
      contextLimit: 200000,
      outputLimit: 8192,
      defaultMaxOutput: 2048,
      supportsReasoning: true,
      price: { input: "3", output: "15", cacheRead: "0.3", cacheWrite: "3.75" },
    })
  ).json.id
  ids.gpt = (await admin.post("/api/admin/models", { providerID: ids.openai, upstreamModel: "mock-chat", alias: "mock-chat", displayName: "Mock Chat", price: { input: "1", output: "2" } })).json.id
  await admin.put(`/api/admin/projects/${ids.project}/models`, { modelIDs: [ids.claude, ids.gpt] })
  const client = webClient(h.origin)
  await client.login("dev-one", "Zx9!Correct-Horse-1")
  token = (await deviceLogin(h.origin, client, ids.project!)).token!.access_token
})

afterAll(async () => {
  await h.stop()
})

describe("anthropic usage normalization", () => {
  test("input excludes cache in the wire format and is normalized to include it", () => {
    const start = anthropicUsage({ input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, undefined)
    expect(start).toEqual({ input: 1300, output: 1, cacheRead: 1000, cacheWrite: 200, reasoning: 0 })
    // message_delta only carries output_tokens; everything else is kept.
    expect(anthropicUsage({ output_tokens: 57 }, start)).toEqual({ input: 1300, output: 57, cacheRead: 1000, cacheWrite: 200, reasoning: 0 })
    expect(anthropicUsage({ output_tokens: 5 }, undefined)).toBeUndefined()
  })
})

describe("anthropic gateway", () => {
  test("remote config pushes the native Anthropic package pointed at the gateway, and allows it", async () => {
    const config = (await fetch(`${h.origin}/api/v2/config`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json())) as any
    expect(config.providers["saorsa-anthropic"].package).toBe("@opencode/ai/providers/anthropic")
    expect(config.providers["saorsa-anthropic"].settings.baseURL).toBe(`${h.origin}/gateway/anthropic/v1`)
    expect(Object.keys(config.providers["saorsa-anthropic"].models)).toEqual(["mock-claude"])
    expect(Object.keys(config.providers.saorsa.models)).toEqual(["mock-chat"])
    expect(config.providers["saorsa-anthropic"].name).toContain("CLAUDE")
    expect(JSON.stringify(config)).not.toContain(MOCK_KEY)
    expect(config.policies).toContainEqual({ action: "provider.use", resource: "saorsa-anthropic", effect: "allow" })
  })

  test("streaming: events pass through verbatim, the org key replaces the member token, cache is billed per category", async () => {
    h.mock.control.anthropicCache = { read: 1000, write: 200 }
    const response = await messages(
      { model: "mock-claude", stream: true, messages: [{ role: "user", content: "Refactor the inference service" }] },
      { "anthropic-beta": "interleaved-thinking-2025-05-14", "x-opencode-session-id": "ses_claude_1" },
    )
    h.mock.control.anthropicCache = undefined
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const text = await response.text()
    for (const event of ["event: message_start", "event: content_block_delta", "event: message_delta", "event: message_stop"]) expect(text).toContain(event)
    expect(text).toContain('"model":"mock-claude-upstream"')
    expect(h.mock.control.lastHeaders?.["x-api-key"]).toBe(MOCK_KEY)
    expect(h.mock.control.lastHeaders?.authorization).toBeUndefined()
    expect(h.mock.control.lastHeaders?.["anthropic-beta"]).toBe("interleaved-thinking-2025-05-14")
    expect(h.mock.control.lastBody?.model).toBe("mock-claude-upstream")
    expect(h.mock.control.lastBody?.max_tokens).toBe(2048)
    expect(h.mock.control.lastBody?.stream_options).toBeUndefined()

    const request = await lastRequest()
    expect(request.protocol).toBe("anthropic-messages")
    expect(request.status).toBe("succeeded")
    expect(request.billing_status).toBe("exact")
    expect(request.project_id).toBe(ids.project)
    expect(request.upstream_request_id).toStartWith("msg_mock_")
    expect(request.opencode_session_id).toBe("ses_claude_1")
    expect(Number(request.cache_read_tokens)).toBe(1000)
    expect(Number(request.cache_write_tokens)).toBe(200)
    const ledger = await h.sql`select category, tokens::int as tokens, cost_micros::int as cost from usage_ledger
      where request_id = ${request.id} order by category`
    const by = Object.fromEntries(ledger.map((row: { category: string; tokens: number; cost: number }) => [row.category, row]))
    // Uncached input is billed at the input price, never the cached part again.
    expect(by.input.tokens).toBe(Number(request.input_tokens) - 1200)
    expect(by.cache_read).toEqual({ category: "cache_read", tokens: 1000, cost: 300 })
    expect(by.cache_write).toEqual({ category: "cache_write", tokens: 200, cost: 750 })
    expect(by.output.tokens).toBe(Number(request.output_tokens))
    expect(ledger.reduce((sum: number, row: { cost: number }) => sum + row.cost, 0)).toBe(Number(request.cost_micros))
  })

  test("non-stream with x-api-key auth returns the managed alias and exact usage", async () => {
    const response = await fetch(`${h.origin}/gateway/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": token, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "mock-claude", max_tokens: 100, messages: [{ role: "user", content: "hi" }] }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as any
    expect(body.type).toBe("message")
    expect(body.model).toBe("mock-claude")
    expect(h.mock.control.lastBody?.max_tokens).toBe(100)
    const request = await lastRequest()
    expect(request.billing_status).toBe("exact")
    expect(Number(request.output_tokens)).toBeGreaterThan(0)
  })

  test("tool use round trip passes through; tool results are scanned for secrets but never treated as prompts", async () => {
    h.mock.control.anthropicToolUse = { name: "read", input: { filePath: "src/app.ts" } }
    const tools = [{ name: "read", description: "Read a file", input_schema: { type: "object", properties: { filePath: { type: "string" } } } }]
    const first = await messages({ model: "mock-claude", stream: true, tools, messages: [{ role: "user", content: "Open the app entry" }] })
    const firstText = await first.text()
    expect(firstText).toContain('"type":"tool_use"')
    expect(firstText).toContain("input_json_delta")
    expect(firstText).toContain('"stop_reason":"tool_use"')

    await admin.patch("/api/admin/policies/project_relevance", { enabled: true, config: { mode: "keyword", min_overlap: 0.9 } })
    const leaked = "AKIAZZZZZZZZZZZZZZZZ"
    const second = await messages(
      {
        model: "mock-claude",
        stream: true,
        tools,
        messages: [
          { role: "user", content: "Open the app entry" },
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_mock_1", name: "read", input: { filePath: "src/app.ts" } }] },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_mock_1", content: [{ type: "text", text: `const awsKey = "${leaked}" // plus many unrelated words about gardening recipes holidays music` }] }],
          },
        ],
      },
      { "x-opencode-session-id": "ses_claude_tools" },
    )
    expect(await second.text()).toContain('"text":" successfully"')
    h.mock.control.anthropicToolUse = undefined
    const risks = await h.sql`select category, evidence from risk_events where user_id = ${ids.member!}`
    expect(risks.map((risk: { category: string }) => risk.category)).toContain("secret_leak")
    expect(JSON.stringify(risks)).not.toContain(leaked)
    // The tool_result turn is user-role on the wire but must not be judged as a human prompt.
    expect(risks.some((risk: { category: string }) => risk.category === "project_relevance")).toBe(false)
    await admin.patch("/api/admin/policies/project_relevance", { enabled: false })
  })

  test("errors use Anthropic's error envelope and protocol endpoints cannot be mixed", async () => {
    const wrongEndpoint = await messages({ model: "mock-chat", messages: [{ role: "user", content: "x" }] })
    expect(wrongEndpoint.status).toBe(400)
    const body = (await wrongEndpoint.json()) as any
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("invalid_request_error")
    expect(body.error.message).toContain("protocol_mismatch")
    const viaOpenAI = await fetch(`${h.origin}/gateway/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-claude", messages: [{ role: "user", content: "x" }] }),
    })
    expect(viaOpenAI.status).toBe(400)
    expect(((await viaOpenAI.json()) as any).error.code).toBe("protocol_mismatch")
    const unauthenticated = await fetch(`${h.origin}/gateway/anthropic/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": "tos_at_nope", "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-claude", messages: [] }),
    })
    expect(unauthenticated.status).toBe(401)
    expect(((await unauthenticated.json()) as any).error.type).toBe("authentication_error")
  })

  test("529 overloaded is retried; an invalid key fails over and cools down", async () => {
    h.mock.control.failNext = { status: 529, count: 1 }
    const recovered = await messages({ model: "mock-claude", messages: [{ role: "user", content: "retry" }] })
    expect(recovered.status).toBe(200)
    await recovered.text()
    expect((await lastRequest()).attempts).toBe(2)
    const bad = await admin.post(`/api/admin/providers/${ids.anthropic}/credentials`, { label: "bad", apiKey: "sk-ant-wrong-000000000000000", priority: 1 })
    const failover = await messages({ model: "mock-claude", messages: [{ role: "user", content: "failover" }] })
    expect(failover.status).toBe(200)
    await failover.text()
    const [credential] = await h.sql`select cooldown_until, last_error from provider_credentials where id = ${bad.json.id}`
    expect(credential.cooldown_until).not.toBeNull()
    expect(credential.last_error).toContain("401")
    await admin.post(`/api/admin/credentials/${bad.json.id}/revoke`)
  })

  test("missing usage is estimated; a broken stream ends with an Anthropic error event", async () => {
    h.mock.control.omitUsage = true
    await (await messages({ model: "mock-claude", stream: true, messages: [{ role: "user", content: "no usage" }] })).text()
    h.mock.control.omitUsage = false
    expect((await lastRequest()).billing_status).toBe("estimated")

    h.mock.control.breakStreamAfter = 2
    const broken = await (await messages({ model: "mock-claude", stream: true, messages: [{ role: "user", content: "break" }] })).text()
    h.mock.control.breakStreamAfter = undefined
    expect(broken).toContain("event: error")
    expect(broken).toContain('"type":"api_error"')
    const row = await lastRequest()
    expect(row.status).toBe("failed")
    expect(row.billing_status).toBe("estimated")
  })

  test("client disconnect cancels upstream and settles once", async () => {
    const response = await messages({ model: "mock-claude", stream: true, messages: [{ role: "user", content: "cancel me" }] })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    const row = await lastRequest()
    expect(["cancelled", "succeeded"]).toContain(row.status)
    // A stream cut before message_delta only has Anthropic's preliminary usage: never billed as exact.
    if (row.status === "cancelled") expect(row.billing_status).toBe("estimated")
    const [lines] = await h.sql`select count(*)::int as n from usage_ledger where request_id = ${row.id} and entry_type = 'charge'`
    const [reservations] = await h.sql`select count(*)::int as n from budget_reservations where request_id = ${row.id} and status = 'reserved'`
    expect(lines.n).toBeLessThanOrEqual(5)
    expect(reservations.n).toBe(0)
  })

  test("budgets apply to the Anthropic path with a 402 in Anthropic format", async () => {
    await admin.post("/api/admin/budgets", { scopeType: "project", projectID: ids.project, period: "daily", limit: "0.001" })
    const response = await messages({ model: "mock-claude", messages: [{ role: "user", content: "over budget" }] })
    expect(response.status).toBe(402)
    const body = (await response.json()) as any
    expect(body.type).toBe("error")
    expect(body.error.type).toBe("permission_error")
    expect(body.error.message).toContain("budget_exceeded")
  })
})
