import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { MOCK_KEY } from "../src/mock-upstream.js"
import { openAPI } from "../src/openapi.js"
import { chat, eventually, seedOrg, startHarness, type Harness } from "./harness.js"

// Distributed rate limits, retry semantics OpenCode relies on, upstream timeouts, and access-control sweeps.

let h: Harness
let org: Awaited<ReturnType<typeof seedOrg>>
const body = (content = "hello") => ({ model: "mock-chat", messages: [{ role: "user", content }] })
const errorOf = async (response: Response) => ((await response.json()) as { error: { code: string; message: string } }).error

beforeAll(async () => {
  h = await startHarness()
  org = await seedOrg(h, { members: 2 })
})

afterAll(async () => {
  await h.stop()
})

// Each test starts from empty windows and default org limits so they do not interfere.
beforeEach(async () => {
  for (const key of (await h.redis.send("KEYS", ["{teamos}:rl:*"])) as string[]) await h.redis.send("DEL", [key])
  await org.admin.patch("/api/admin/settings", {
    userRequestsPerMinute: 120,
    projectRequestsPerMinute: 1200,
    userConcurrency: 6,
    userTokensPerMinute: 2_000_000,
    projectTokensPerMinute: 20_000_000,
  })
  Object.assign(h.mock.control, { failNext: undefined, delayMs: undefined, stallAfter: undefined, replyText: undefined })
})

const token = (index = 0) => org.members[index]!.token

describe("request rate limits", () => {
  test("member RPM is enforced atomically under concurrency, with retry guidance OpenCode honours", async () => {
    await org.admin.patch("/api/admin/settings", { userRequestsPerMinute: 5 })
    const results = await Promise.all(Array.from({ length: 20 }, () => chat(h.origin, token(), body())))
    const ok = results.filter((response) => response.status === 200)
    const limited = results.filter((response) => response.status === 429)
    // No overshoot across concurrent admissions: exactly the limit gets through.
    expect(ok.length).toBe(5)
    expect(limited.length).toBe(15)
    expect(limited[0]!.headers.get("x-should-retry")).toBe("true")
    expect(Number(limited[0]!.headers.get("retry-after"))).toBeGreaterThanOrEqual(1)
    expect((await errorOf(limited[0]!)).code).toBe("rate_limited")
    await Promise.all(results.map((response) => response.text().catch(() => "")))
    // The other member has an independent window.
    expect((await chat(h.origin, token(1), body())).status).toBe(200)
    const system = await org.admin.get("/api/admin/system")
    expect(system.json.rateLimitRejectionsLastHour.requests_per_minute).toBeGreaterThanOrEqual(15)
  })

  test("project RPM override aggregates all members of the project", async () => {
    await org.admin.patch(`/api/admin/projects/${org.projectID}`, { requestsPerMinute: 3 })
    const statuses = []
    for (const index of [0, 1, 0, 1]) statuses.push((await chat(h.origin, token(index), body())).status)
    expect(statuses).toEqual([200, 200, 200, 429])
    await org.admin.patch(`/api/admin/projects/${org.projectID}`, { requestsPerMinute: null })
  })

  test("model and provider RPM protect upstream account limits", async () => {
    await org.admin.patch(`/api/admin/models/${org.modelID}`, { requestsPerMinute: 1 })
    expect((await chat(h.origin, token(), body())).status).toBe(200)
    const limited = await chat(h.origin, token(1), body())
    expect(limited.status).toBe(429)
    expect((await errorOf(limited)).message).toContain("mock-chat")
    await org.admin.patch(`/api/admin/models/${org.modelID}`, { requestsPerMinute: null })
    await org.admin.patch(`/api/admin/providers/${org.providerID}`, { requestsPerMinute: 1 })
    for (const key of (await h.redis.send("KEYS", ["{teamos}:rl:*"])) as string[]) await h.redis.send("DEL", [key])
    expect((await chat(h.origin, token(), body())).status).toBe(200)
    expect((await chat(h.origin, token(1), body())).status).toBe(429)
    await org.admin.patch(`/api/admin/providers/${org.providerID}`, { requestsPerMinute: null })
  })
})

describe("token rate limits", () => {
  test("a single request larger than the token window is refused permanently", async () => {
    await org.admin.patch("/api/admin/settings", { userTokensPerMinute: 1000 })
    const response = await chat(h.origin, token(), body("x".repeat(8000)))
    expect(response.status).toBe(413)
    expect(response.headers.get("x-should-retry")).toBe("false")
    expect((await errorOf(response)).code).toBe("request_exceeds_token_rate")
  })

  test("windows are corrected with real usage and then throttle further requests", async () => {
    await org.admin.patch("/api/admin/settings", { userTokensPerMinute: 1200 })
    const first = await chat(h.origin, token(), body("y".repeat(2000)))
    expect(first.status).toBe(200)
    await first.text()
    const request = await eventually(
      async () => (await h.sql`select status, input_tokens::int as input, output_tokens::int as output from gateway_requests order by started_at desc limit 1`)[0],
      (row) => row?.status === "succeeded",
    )
    // The bucket holds actual input+output, not the admission estimate.
    const bucket = Math.floor(Date.now() / 60_000)
    const used = await eventually(
      async () => Number(await h.redis.send("GET", [`{teamos}:rl:tok:user:${org.members[0]!.id}:${bucket}`])),
      (value) => value === request.input + request.output,
    )
    expect(used).toBe(request.input + request.output)
    const second = await chat(h.origin, token(), body("z".repeat(3000)))
    expect(second.status).toBe(429)
    expect((await errorOf(second)).message).toContain("tokens per minute")
  })

  test("rejected requests give their admitted tokens back", async () => {
    await org.admin.patch("/api/admin/settings", { userTokensPerMinute: 5000 })
    const blocked = await chat(h.origin, token(), { model: "not-a-model", messages: [{ role: "user", content: "q".repeat(4000) }] })
    expect(blocked.status).toBe(404)
    const notAllowedTokens = Number(await h.redis.send("GET", [`{teamos}:rl:tok:user:${org.members[0]!.id}:${Math.floor(Date.now() / 60_000)}`]))
    // Model resolution happens before admission, so nothing was charged.
    expect(notAllowedTokens).toBe(0)
    await h.sql`insert into budgets (scope_type, user_id, period, limit_micros) values ('user', ${org.members[0]!.id}, 'daily', 1)`
    const overBudget = await chat(h.origin, token(), body("w".repeat(4000)))
    expect(overBudget.status).toBe(402)
    expect(overBudget.headers.get("x-should-retry")).toBe("false")
    const after = Number(await h.redis.send("GET", [`{teamos}:rl:tok:user:${org.members[0]!.id}:${Math.floor(Date.now() / 60_000)}`]))
    expect(after).toBe(0)
    await h.sql`delete from budget_counters where budget_id in (select id from budgets where user_id = ${org.members[0]!.id})`
    await h.sql`delete from budget_reservations where budget_id in (select id from budgets where user_id = ${org.members[0]!.id})`
    await h.sql`delete from budgets where user_id = ${org.members[0]!.id}`
  })
})

describe("concurrency limits", () => {
  test("model concurrency returns model_busy while a slot is held and frees it afterwards", async () => {
    await org.admin.patch(`/api/admin/models/${org.modelID}`, { concurrencyLimit: 1 })
    h.mock.control.delayMs = 400
    const [first, second] = await Promise.all([
      chat(h.origin, token(), body("slow")),
      Bun.sleep(100).then(() => chat(h.origin, token(1), body("second"))),
    ])
    expect(first!.status).toBe(200)
    expect(second!.status).toBe(429)
    expect(second!.headers.get("retry-after")).toBe("2")
    expect((await errorOf(second!)).code).toBe("model_busy")
    await first!.text()
    h.mock.control.delayMs = undefined
    expect(await eventually(() => h.deps.limiter.inFlight(`model:${org.modelID}`), (count) => count === 0)).toBe(0)
    expect((await chat(h.origin, token(1), body())).status).toBe(200)
    await org.admin.patch(`/api/admin/models/${org.modelID}`, { concurrencyLimit: null })
  })

  test("provider concurrency and streaming leases are released when streams end or are cancelled", async () => {
    await org.admin.patch(`/api/admin/providers/${org.providerID}`, { concurrencyLimit: 1 })
    const stream = await chat(h.origin, token(), { ...body("stream"), stream: true })
    const reader = stream.body!.getReader()
    await reader.read()
    const busy = await chat(h.origin, token(1), body())
    expect(busy.status).toBe(429)
    expect((await errorOf(busy)).code).toBe("provider_busy")
    await reader.cancel()
    expect(await eventually(() => h.deps.limiter.inFlight(`provider:${org.providerID}`), (count) => count === 0)).toBe(0)
    expect((await chat(h.origin, token(1), body())).status).toBe(200)
    await org.admin.patch(`/api/admin/providers/${org.providerID}`, { concurrencyLimit: null })
  })

  test("a lease abandoned by a crashed process expires on its own", async () => {
    const slot = [{ scope: "test:crash", limit: 1, label: "test slot", code: "concurrency_limited" as const }]
    // A replica that died mid-request leaves its lease behind and never renews it.
    await h.redis.send("ZADD", ["{teamos}:cc:test:crash", String(Date.now() + 300), "crashed-request"])
    await expect(h.deps.limiter.acquire(slot, "next-request", 300)).rejects.toThrow("Too many concurrent requests")
    await Bun.sleep(350)
    const lease = await h.deps.limiter.acquire(slot, "next-request", 300)
    await lease.release()
    expect(await h.deps.limiter.inFlight("test:crash")).toBe(0)
  })
})

describe("upstream error semantics", () => {
  test("upstream request errors keep their status and code so OpenCode can detect context overflow", async () => {
    h.mock.control.failNext = { status: 400, count: 1, code: "context_length_exceeded", message: "This model's maximum context length is 8192 tokens" }
    const response = await chat(h.origin, token(), body())
    expect(response.status).toBe(400)
    expect(response.headers.get("x-should-retry")).toBe("false")
    const error = await errorOf(response)
    expect(error.code).toBe("context_length_exceeded")
    expect(error.message).toContain("maximum context length")
  })

  test("upstream retry-after is forwarded; an exhausted provider account is not retried", async () => {
    h.mock.control.failNext = { status: 429, count: 5, retryAfter: 17 }
    const limited = await chat(h.origin, token(), body())
    expect(limited.status).toBe(429)
    expect(limited.headers.get("retry-after")).toBe("17")
    expect(limited.headers.get("x-should-retry")).toBe("true")
    await h.sql`update provider_credentials set cooldown_until = null`
    h.mock.control.failNext = { status: 429, count: 5, code: "insufficient_quota", message: "You exceeded your current quota" }
    const quota = await chat(h.origin, token(), body())
    expect(quota.status).toBe(503)
    expect(quota.headers.get("x-should-retry")).toBe("false")
    expect((await errorOf(quota)).code).toBe("upstream_account_quota")
    await h.sql`update provider_credentials set cooldown_until = null`
  })

  test("leaked secrets in upstream error text are redacted before storage and display", async () => {
    h.mock.control.failNext = { status: 400, count: 1, message: "invalid header value sk-proj-abcdefghijklmnopqrstuvwxyz123456" }
    const response = await chat(h.origin, token(), body())
    expect(JSON.stringify(await response.json())).not.toContain("abcdefghijklmnopqrstuvwxyz123456")
    const [row] = await h.sql`select error_message from gateway_requests order by started_at desc limit 1`
    expect(row.error_message).toContain("REDACTED")
  })

  test("a silent upstream stream times out, releases its lease and bills an estimate", async () => {
    ;(h.deps.env as { TEAMOS_UPSTREAM_IDLE_TIMEOUT_SECONDS: number }).TEAMOS_UPSTREAM_IDLE_TIMEOUT_SECONDS = 1
    h.mock.control.stallAfter = 2
    const response = await chat(h.origin, token(), { ...body("stall"), stream: true })
    const text = await response.text()
    ;(h.deps.env as { TEAMOS_UPSTREAM_IDLE_TIMEOUT_SECONDS: number }).TEAMOS_UPSTREAM_IDLE_TIMEOUT_SECONDS = 300
    expect(text).toContain("no data from upstream")
    const row = await eventually(
      async () => (await h.sql`select status, billing_status, error_message from gateway_requests order by started_at desc limit 1`)[0],
      (value) => value?.status === "failed",
    )
    expect(row.billing_status).toBe("estimated")
    expect(await h.deps.limiter.inFlight(`user:${org.members[0]!.id}`)).toBe(0)
    const [reserved] = await h.sql`select count(*)::int as n from budget_reservations where status = 'reserved'`
    expect(reserved.n).toBe(0)
  })

  test("an upstream that never sends headers fails with a retryable 504", async () => {
    ;(h.deps.env as { TEAMOS_UPSTREAM_HEADER_TIMEOUT_SECONDS: number }).TEAMOS_UPSTREAM_HEADER_TIMEOUT_SECONDS = 1
    h.mock.control.delayMs = 2500
    const response = await chat(h.origin, token(), body())
    ;(h.deps.env as { TEAMOS_UPSTREAM_HEADER_TIMEOUT_SECONDS: number }).TEAMOS_UPSTREAM_HEADER_TIMEOUT_SECONDS = 300
    expect(response.status).toBe(504)
    expect(response.headers.get("x-should-retry")).toBe("true")
    expect((await errorOf(response)).code).toBe("upstream_timeout")
    await Bun.sleep(1600)
  })
})

describe("attribution cannot be tampered with", () => {
  test("client headers and body fields never change the user, project or billed model", async () => {
    const response = await chat(h.origin, token(), { ...body(), user: org.members[1]!.id, project_id: "x", metadata: { project: "x" } }, {
      "x-opencode-project": "spoofed",
      "x-teamos-project": crypto.randomUUID(),
      "x-user-id": org.members[1]!.id,
      "x-opencode-session-id": "ses_<script>alert(1)</script>",
    })
    expect(response.status).toBe(200)
    await response.text()
    const [row] = await h.sql`select user_id, project_id, model_id, opencode_session_id from gateway_requests order by started_at desc limit 1`
    expect(row.user_id).toBe(org.members[0]!.id)
    expect(row.project_id).toBe(org.projectID)
    expect(row.model_id).toBe(org.modelID)
    expect(row.opencode_session_id).toBe("ses_scriptalert1/script")
  })
})

describe("access control sweep", () => {
  const routes = Object.entries(openAPI.paths).flatMap(([path, methods]) =>
    Object.entries(methods as Record<string, { tags: string[] }>).map(([method, spec]) => ({
      method: method.toUpperCase(),
      path: path.replace(/\{[^}]+\}/g, crypto.randomUUID()),
      access: spec.tags[0],
    })),
  )

  test("every admin route rejects members (403) and anonymous callers (401)", async () => {
    const member = org.members[0]!.client
    const admin = routes.filter((route) => route.access === "admin" && !route.path.endsWith("/events"))
    expect(admin.length).toBeGreaterThan(40)
    for (const route of admin) {
      const asMember = await member.call(route.method, route.path, route.method === "GET" ? undefined : {})
      expect({ route: `${route.method} ${route.path}`, status: asMember.status }).toEqual({ route: `${route.method} ${route.path}`, status: 403 })
      const anonymous = await fetch(`${h.origin}${route.path}`, { method: route.method, headers: { "x-teamos-csrf": "1" } })
      expect({ route: `${route.method} ${route.path}`, status: anonymous.status }).toEqual({ route: `${route.method} ${route.path}`, status: 401 })
    }
  })

  test("member and client routes require authentication; gateway refuses web cookies", async () => {
    for (const route of routes.filter((item) => item.access === "member" || item.access === "client")) {
      const response = await fetch(`${h.origin}${route.path}`, { method: route.method, headers: { "content-type": "application/json" }, body: route.method === "GET" ? undefined : "{}" })
      expect({ route: `${route.method} ${route.path}`, ok: response.status === 401 || response.status === 400 }).toEqual({ route: `${route.method} ${route.path}`, ok: true })
    }
    const viaCookie = await fetch(`${h.origin}/gateway/v1/chat/completions`, {
      method: "POST",
      headers: { cookie: org.members[0]!.client.cookie, "content-type": "application/json" },
      body: JSON.stringify(body()),
    })
    expect(viaCookie.status).toBe(401)
  })

  test("cookie-authenticated writes without the CSRF header are refused", async () => {
    const response = await fetch(`${h.origin}/api/me/notifications/read`, {
      method: "POST",
      headers: { cookie: org.members[0]!.client.cookie, "content-type": "application/json" },
      body: "{}",
    })
    expect(response.status).toBe(403)
  })

  test("no response or log line ever contains the provider key", async () => {
    const providers = await org.admin.get("/api/admin/providers")
    expect(providers.text).not.toContain(MOCK_KEY)
    expect(h.logs.join("\n")).not.toContain(MOCK_KEY)
  })
})

describe("unauthenticated endpoint throttling", () => {
  test("device code issuance is throttled per address", async () => {
    const statuses: number[] = []
    for (let index = 0; index < 22; index++)
      statuses.push((await fetch(`${h.origin}/auth/device/code`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status)
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0)
  })
})
