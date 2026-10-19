import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { MOCK_KEY } from "../src/mock-upstream.js"
import { BOOTSTRAP_TOKEN, chat, deviceLogin, eventually, startHarness, webClient, type Harness, type WebClient } from "./harness.js"

// End-to-end acceptance flow against real PostgreSQL + Redis and the clearly-labelled mock upstream.
// Numbers in test names refer to the acceptance checklist in docs/acceptance.md.

let h: Harness
let admin: WebClient
const ids = {} as Record<string, string>
const tokens = {} as Record<string, { access_token: string; refresh_token: string }>
const passwords = {} as Record<string, string>
const ADMIN_PASSWORD = "Adm1n!Strong-Passphrase"

beforeAll(async () => {
  h = await startHarness()
  admin = webClient(h.origin)
})

afterAll(async () => {
  await h.stop()
})

async function ledgerTotal(filter: { projectID?: string; userID?: string } = {}) {
  const [row] = await h.sql`select coalesce(sum(cost_micros), 0)::bigint as total, count(*)::int as lines from usage_ledger
    where (${filter.projectID ?? null}::uuid is null or project_id = ${filter.projectID ?? null}::uuid)
      and (${filter.userID ?? null}::uuid is null or user_id = ${filter.userID ?? null}::uuid)`
  return { total: Number(row.total), lines: row.lines as number }
}

describe("01 bootstrap", () => {
  test("rejects a wrong bootstrap token and weak passwords, then initializes once", async () => {
    expect((await admin.get("/api/auth/status")).json.initialized).toBe(false)
    const wrong = await admin.post("/api/auth/bootstrap", {
      token: "nope",
      organization: "Acme AI Center",
      username: "root-admin",
      displayName: "Root Admin",
      password: ADMIN_PASSWORD,
    })
    expect(wrong.status).toBe(403)
    const weak = await admin.post("/api/auth/bootstrap", {
      token: BOOTSTRAP_TOKEN,
      organization: "Acme AI Center",
      username: "root-admin",
      displayName: "Root Admin",
      password: "admin",
    })
    expect(weak.status).toBe(422)
    const ok = await admin.post("/api/auth/bootstrap", {
      token: BOOTSTRAP_TOKEN,
      organization: "Acme AI Center",
      username: "root-admin",
      displayName: "Root Admin",
      password: ADMIN_PASSWORD,
      timezone: "Asia/Shanghai",
    })
    expect(ok.status).toBe(200)
    const again = await admin.post("/api/auth/bootstrap", {
      token: BOOTSTRAP_TOKEN,
      organization: "Other",
      username: "second",
      displayName: "Second",
      password: ADMIN_PASSWORD,
    })
    expect(again.status).toBe(409)
    expect((await admin.login("root-admin", ADMIN_PASSWORD)).status).toBe(200)
    expect((await admin.get("/api/me")).json.user.accountType).toBe("ADMIN")
    // This journey covers shared keys and one member on several devices; keys.test.ts covers the defaults.
    expect((await admin.patch("/api/admin/settings", { keyAssignment: "shared", singleDeviceLogin: false })).status).toBe(200)
  })

  test("there is no public registration endpoint", async () => {
    expect((await admin.post("/api/auth/register", { username: "x" })).status).toBe(404)
  })
})

describe("02 projects and members", () => {
  test("admin creates two projects and three members; member B joins both", async () => {
    const alpha = await admin.post("/api/admin/projects", {
      code: "ALPHA",
      name: "Alpha Vision",
      purpose: "Computer vision pipeline for defect detection: image preprocessing, model training, inference service",
      tags: ["vision", "pytorch"],
    })
    const beta = await admin.post("/api/admin/projects", { code: "BETA", name: "Beta Ledger", purpose: "Accounting ledger web backend" })
    expect(alpha.status).toBe(201)
    expect(beta.status).toBe(201)
    ids.alpha = alpha.json.id
    ids.beta = beta.json.id
    for (const [name, projects] of [
      ["member-a", [ids.alpha]],
      ["member-b", [ids.alpha, ids.beta]],
      ["member-c", [ids.beta]],
    ] as const) {
      const created = await admin.post("/api/admin/users", { username: name, displayName: name.toUpperCase(), projectIDs: projects })
      expect(created.status).toBe(201)
      expect(created.json.temporaryPassword).toBeString()
      ids[name] = created.json.id
      passwords[name] = created.json.temporaryPassword
    }
    const detail = await admin.get(`/api/admin/projects/${ids.alpha}`)
    expect(detail.json.members.map((member: { username: string }) => member.username).toSorted()).toEqual(["member-a", "member-b"])
  })
})

describe("04 provider keys", () => {
  test("admin adds a provider key that is encrypted at rest and never returned", async () => {
    const provider = await admin.post("/api/admin/providers", { name: "Mock Provider (TEST)", protocol: "openai-chat", baseURL: h.mock.url })
    expect(provider.status).toBe(201)
    ids.provider = provider.json.id
    const credential = await admin.post(`/api/admin/providers/${ids.provider}/credentials`, { label: "primary", apiKey: MOCK_KEY })
    expect(credential.status).toBe(201)
    ids.credential = credential.json.id
    const [row] = await h.sql`select ciphertext from provider_credentials where id = ${ids.credential}`
    expect(Buffer.from(row.ciphertext).toString("utf8")).not.toContain(MOCK_KEY)
    const list = await admin.get("/api/admin/providers")
    expect(list.text).not.toContain(MOCK_KEY)
    expect(list.json.providers[0].credentials[0].masked).toEndWith(MOCK_KEY.slice(-4))
    const health = await admin.post(`/api/admin/providers/${ids.provider}/health`)
    expect(health.json.status).toBe("healthy")
  })

  test("SSRF guard: private upstreams are refused when not explicitly allowed", async () => {
    const { validateUpstreamBaseURL } = await import("../src/upstream.js")
    const strict = { ...h.deps.env, TEAMOS_ALLOW_PRIVATE_UPSTREAMS: false }
    await expect(validateUpstreamBaseURL(strict, "http://127.0.0.1:8080/v1")).rejects.toThrow("HTTPS")
    await expect(validateUpstreamBaseURL(strict, "https://169.254.169.254/latest")).rejects.toThrow("allowlist")
    await expect(validateUpstreamBaseURL(strict, "https://user:pw@api.openai.com/v1")).rejects.toThrow("credentials")
  })

  test("admin registers a priced model and authorizes it for both projects", async () => {
    const model = await admin.post("/api/admin/models", {
      providerID: ids.provider,
      upstreamModel: "mock-chat",
      alias: "mock-chat",
      displayName: "Mock Chat",
      contextLimit: 128000,
      outputLimit: 8192,
      defaultMaxOutput: 1024,
      price: { currency: "USD", input: "3", output: "15", cacheRead: "0.3" },
    })
    expect(model.status).toBe(201)
    ids.model = model.json.id
    const second = await admin.post("/api/admin/models", {
      providerID: ids.provider,
      upstreamModel: "mock-chat-premium",
      alias: "mock-premium",
      displayName: "Mock Premium",
      price: { input: "30", output: "60" },
    })
    ids.premium = second.json.id
    expect((await admin.put(`/api/admin/projects/${ids.alpha}/models`, { modelIDs: [ids.model] })).status).toBe(200)
    expect((await admin.put(`/api/admin/projects/${ids.beta}/models`, { modelIDs: [ids.model] })).status).toBe(200)
  })
})

describe("05 OpenCode enterprise login", () => {
  const members = {} as Record<string, WebClient>

  test("members log in, change temporary passwords, and connect OpenCode to an authorized project", async () => {
    for (const name of ["member-a", "member-b", "member-c"]) {
      const client = webClient(h.origin)
      expect((await client.login(name, passwords[name]!)).json.user.mustChangePassword).toBe(true)
      const next = `Zx9!Correct-Horse-${name.slice(-1)}`
      expect((await client.post("/api/me/password", { current: passwords[name], next })).status).toBe(200)
      passwords[name] = next
      members[name] = client
    }
    const a = await deviceLogin(h.origin, members["member-a"]!, ids.alpha!)
    expect(a.approve.status).toBe(200)
    expect(a.token?.org_id).toBe(ids.alpha)
    tokens.a = a.token!
    const bAlpha = await deviceLogin(h.origin, members["member-b"]!, ids.alpha!)
    tokens.bAlpha = bAlpha.token!
    const bBeta = await deviceLogin(h.origin, members["member-b"]!, ids.beta!)
    tokens.bBeta = bBeta.token!
    const c = await deviceLogin(h.origin, members["member-c"]!, ids.beta!)
    tokens.c = c.token!
  })

  test("03 a member cannot select a project they do not belong to", async () => {
    const denied = await deviceLogin(h.origin, members["member-a"]!, ids.beta!)
    expect(denied.approve.status).toBe(403)
  })

  test("remote config exposes only the managed provider, authorized models and the bypass-deny policy", async () => {
    const response = await fetch(`${h.origin}/api/v2/config`, { headers: { authorization: `Bearer ${tokens.a!.access_token}` } })
    const config = (await response.json()) as any
    expect(Object.keys(config.providers)).toEqual(["saorsa"])
    expect(config.providers.saorsa.name).toContain("ALPHA")
    expect(Object.keys(config.providers.saorsa.models)).toEqual(["mock-chat"])
    expect(config.providers.saorsa.settings.baseURL).toBe(`${h.origin}/gateway/v1`)
    expect(JSON.stringify(config)).not.toContain(MOCK_KEY)
    expect(config.policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "saorsa", effect: "allow" },
      { action: "provider.use", resource: "saorsa-anthropic", effect: "allow" },
    ])
    // No Anthropic-protocol model is authorized, so no second provider is pushed.
    expect(config.providers["saorsa-anthropic"]).toBeUndefined()
    const orgs = await fetch(`${h.origin}/api/orgs`, { headers: { authorization: `Bearer ${tokens.bAlpha!.access_token}` } }).then((r) => r.json())
    expect((orgs as unknown[]).length).toBe(2)
  })

  test("13 members cannot call admin APIs or the admin event stream", async () => {
    expect((await members["member-a"]!.get("/api/admin/users")).status).toBe(403)
    expect((await members["member-a"]!.get("/api/admin/events")).status).toBe(403)
    expect((await members["member-a"]!.get("/api/admin/usage/summary")).status).toBe(403)
    const gatewayWithCookie = await fetch(`${h.origin}/gateway/v1/models`, { headers: { cookie: members["member-a"]!.cookie } })
    expect(gatewayWithCookie.status).toBe(401)
  })

  test("06/07 streaming request is proxied, metered from upstream usage and attributed to the token's project", async () => {
    const events: string[] = []
    const controller = new AbortController()
    const sse = await fetch(`${h.origin}/api/admin/events`, { headers: { cookie: admin.cookie }, signal: controller.signal })
    const reader = sse.body!.getReader()
    void (async () => {
      const decoder = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }))
        if (done) return
        events.push(decoder.decode(value))
      }
    })()
    await Bun.sleep(50)
    const response = await chat(
      h.origin,
      tokens.a!.access_token,
      { model: "mock-chat", stream: true, messages: [{ role: "user", content: "Write a test for the image preprocessing pipeline" }] },
      { "x-opencode-session-id": "ses_test_1", "x-opencode-project": "spoofed-project" },
    )
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain("Hello")
    expect(text).toContain("[DONE]")
    expect(h.mock.control.lastBody?.stream_options).toEqual({ include_usage: true })
    expect(h.mock.control.lastBody?.max_tokens).toBe(1024)
    const request = await eventually(
      async () => (await h.sql`select * from gateway_requests where user_id = ${ids["member-a"]!} order by started_at desc limit 1`)[0],
      (row) => row?.status === "succeeded",
    )
    expect(request.project_id).toBe(ids.alpha)
    expect(request.billing_status).toBe("exact")
    expect(Number(request.output_tokens)).toBeGreaterThan(0)
    expect(Number(request.cost_micros)).toBeGreaterThan(0)
    expect(request.opencode_session_id).toBe("ses_test_1")
    const ledger = await ledgerTotal({ userID: ids["member-a"] })
    expect(ledger.total).toBe(Number(request.cost_micros))
    const summary = await admin.get(`/api/admin/usage/summary?project=${ids.alpha}`)
    expect(summary.json.summary.requests).toBe(1)
    await eventually(async () => events.join(""), (value) => value.includes("usage.request"))
    expect(events.join("")).toContain("usage.request")
    controller.abort()
  })

  test("non-stream request works and reports the managed alias", async () => {
    const response = await chat(h.origin, tokens.c!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "hi" }] })
    expect(response.status).toBe(200)
    const body = (await response.json()) as any
    expect(body.model).toBe("mock-chat")
    expect(body.choices[0].message.content).toContain("mock")
  })

  test("08 the same member switching projects bills each project separately without double counting", async () => {
    const before = await ledgerTotal()
    await (await chat(h.origin, tokens.bAlpha!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "alpha work" }] })).text()
    await (await chat(h.origin, tokens.bBeta!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "beta work" }] })).text()
    const rows = await h.sql`select project_id, cost_micros from gateway_requests where user_id = ${ids["member-b"]!} order by started_at`
    expect(rows.map((row: { project_id: string }) => row.project_id)).toEqual([ids.alpha, ids.beta])
    const after = await ledgerTotal()
    const sum = rows.reduce((total: number, row: { cost_micros: string }) => total + Number(row.cost_micros), 0)
    expect(after.total - before.total).toBe(sum)
    const byProject = await admin.get(`/api/admin/usage/breakdown?by=project&user=${ids["member-b"]}`)
    expect(byProject.json.rows.length).toBe(2)
  })

  test("08b switching an OpenCode session's billing project server-side moves subsequent charges", async () => {
    const sessions = await members["member-b"]!.get("/api/me/sessions")
    const alphaSession = sessions.json.sessions.find((session: { kind: string; project_id: string }) => session.kind === "client" && session.project_id === ids.alpha)
    const switched = await members["member-b"]!.post("/api/me/active-project", { sessionID: alphaSession.id, projectID: ids.beta })
    expect(switched.status).toBe(200)
    await (await chat(h.origin, tokens.bAlpha!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "now billed to beta" }] })).text()
    const [last] = await h.sql`select project_id from gateway_requests where user_id = ${ids["member-b"]!} order by started_at desc limit 1`
    expect(last.project_id).toBe(ids.beta)
    // Switch back for later tests.
    await members["member-b"]!.post("/api/me/active-project", { sessionID: alphaSession.id, projectID: ids.alpha })
    const audit = await h.sql`select count(*)::int as n from audit_logs where action = 'client.project_switched' and actor_user_id = ${ids["member-b"]!}`
    expect(audit[0].n).toBe(2)
  })

  test("09 an idempotency key retry is rejected and never charged twice", async () => {
    const first = await chat(h.origin, tokens.a!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "once" }] }, { "idempotency-key": "retry-1" })
    expect(first.status).toBe(200)
    await first.text()
    const before = await ledgerTotal()
    const retry = await chat(h.origin, tokens.a!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "once" }] }, { "idempotency-key": "retry-1" })
    expect(retry.status).toBe(409)
    expect(((await retry.json()) as any).error.code).toBe("duplicate_request")
    expect(await ledgerTotal()).toEqual(before)
  })

  test("10 missing upstream usage is stored as estimated, never as exact", async () => {
    h.mock.control.omitUsage = true
    const response = await chat(h.origin, tokens.a!.access_token, { model: "mock-chat", stream: true, messages: [{ role: "user", content: "no usage please" }] })
    await response.text()
    h.mock.control.omitUsage = false
    const row = await eventually(
      async () => (await h.sql`select billing_status, status from gateway_requests where user_id = ${ids["member-a"]!} order by started_at desc limit 1`)[0],
      (value) => value?.status === "succeeded",
    )
    expect(row.billing_status).toBe("estimated")
    const [line] = await h.sql`select bool_and(estimated) as estimated, min(source) as source from usage_ledger
      where request_id = (select id from gateway_requests where user_id = ${ids["member-a"]!} order by started_at desc limit 1)`
    expect(line.estimated).toBe(true)
    expect(line.source).toBe("estimate")
  })

  test("model permissions: an unauthorized model is refused with 403", async () => {
    const response = await chat(h.origin, tokens.a!.access_token, { model: "mock-premium", messages: [{ role: "user", content: "x" }] })
    expect(response.status).toBe(403)
    expect(((await response.json()) as any).error.code).toBe("model_not_allowed")
  })

  test("14 upstream failures are retried, recorded and surfaced with semantic errors", async () => {
    h.mock.control.failNext = { status: 500, count: 1 }
    const recovered = await chat(h.origin, tokens.c!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "retry me" }] })
    expect(recovered.status).toBe(200)
    await recovered.text()
    const [attempts] = await h.sql`select attempts from gateway_requests where user_id = ${ids["member-c"]!} order by started_at desc limit 1`
    // A transient 500 retries the same key; the client never sees the failure.
    expect(attempts.attempts).toBe(2)

    const second = await admin.post(`/api/admin/providers/${ids.provider}/credentials`, { label: "secondary", apiKey: MOCK_KEY, priority: 200 })
    expect(second.status).toBe(201)
    h.mock.control.failNext = { status: 429, count: 5 }
    const limited = await chat(h.origin, tokens.c!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "rate limited" }] })
    expect(limited.status).toBe(429)
    expect(((await limited.json()) as any).error.code).toBe("upstream_rate_limited")
    h.mock.control.failNext = undefined
    const [failed] = await h.sql`select r.status, r.attempts, (select count(*)::int from gateway_attempts a where a.request_id = r.id) as attempt_rows
      from gateway_requests r where r.user_id = ${ids["member-c"]!} order by r.started_at desc limit 1`
    expect(failed.status).toBe("failed")
    expect(failed.attempt_rows).toBe(2)
    // Clear cooldowns from the 429 so later tests have keys.
    await h.sql`update provider_credentials set cooldown_until = null`

    h.mock.control.breakStreamAfter = 2
    const broken = await chat(h.origin, tokens.c!.access_token, { model: "mock-chat", stream: true, messages: [{ role: "user", content: "break" }] })
    const text = await broken.text()
    h.mock.control.breakStreamAfter = undefined
    expect(text).toContain("stream_interrupted")
    const row = await eventually(
      async () => (await h.sql`select status, billing_status from gateway_requests where user_id = ${ids["member-c"]!} order by started_at desc limit 1`)[0],
      (value) => value?.status !== "streaming" && value?.status !== "pending",
    )
    expect(row.status).toBe("failed")
    expect(row.billing_status).toBe("estimated")
  })

  test("14b an invalid upstream key fails over and is put on cooldown", async () => {
    const bad = await admin.post(`/api/admin/providers/${ids.provider}/credentials`, { label: "revoked-upstream", apiKey: "sk-wrong-key-000000000000", priority: 1 })
    const response = await chat(h.origin, tokens.c!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "failover" }] })
    expect(response.status).toBe(200)
    await response.text()
    const [credential] = await h.sql`select cooldown_until, last_error from provider_credentials where id = ${bad.json.id}`
    expect(credential.cooldown_until).not.toBeNull()
    expect(credential.last_error).toContain("401")
    await admin.post(`/api/admin/credentials/${bad.json.id}/revoke`)
  })

  test("11 project budget exhaustion rejects new requests; concurrent requests cannot overspend", async () => {
    // $0.05 per day for BETA; each request reserves ~1024 output tokens * $15/M ≈ $0.0154 plus input.
    const budget = await admin.post("/api/admin/budgets", { scopeType: "project", projectID: ids.beta, period: "daily", limit: "0.05", warnThresholds: [50, 80] })
    expect(budget.status).toBe(201)
    ids.budget = budget.json.id
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        chat(h.origin, tokens.c!.access_token, { model: "mock-chat", messages: [{ role: "user", content: `parallel ${index}` }] }).then(async (response) => ({
          status: response.status,
          body: await response.text(),
        })),
      ),
    )
    const rejected = results.filter((result) => result.status === 402)
    expect(rejected.length).toBeGreaterThan(0)
    expect(JSON.parse(rejected[0]!.body).error.code).toBe("budget_exceeded")
    const status = await admin.get("/api/admin/budgets")
    const beta = status.json.budgets.find((item: { id: string }) => item.id === ids.budget)
    expect(beta.spent_micros + beta.reserved_micros).toBeLessThanOrEqual(50_000)
    expect(beta.reserved_micros).toBe(0)
    // Rejections come from in-flight reservations (worst-case estimates), so actual spend stays well below the limit.
    expect(beta.spent_micros).toBeLessThan(50_000)
    // A temporary raise lets work continue and is recorded.
    expect((await admin.post(`/api/admin/budgets/${ids.budget}/raise`, { amount: "1", note: "release crunch" })).status).toBe(200)
    const ok = await chat(h.origin, tokens.c!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "after raise" }] })
    expect(ok.status).toBe(200)
    await ok.text()
    expect((await admin.get(`/api/admin/budgets/${ids.budget}/adjustments`)).json.adjustments[0].kind).toBe("temporary_raise")
  })

  test("11b soft budgets alert at thresholds without blocking and notify the member", async () => {
    const soft = await admin.post("/api/admin/budgets", {
      scopeType: "user",
      userID: ids["member-a"],
      period: "monthly",
      limit: "0.0001",
      hardLimit: false,
      warnThresholds: [80],
    })
    expect(soft.status).toBe(201)
    const response = await chat(h.origin, tokens.a!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "soft budget" }] })
    expect(response.status).toBe(200)
    await response.text()
    const alerts = await admin.get("/api/admin/budget-alerts")
    const mine = alerts.json.alerts.filter((alert: { username: string }) => alert.username === "member-a")
    expect(mine.map((alert: { threshold: number }) => alert.threshold).toSorted()).toEqual([100, 80])
    const member = webClient(h.origin)
    await member.login("member-a", passwords["member-a"]!)
    const notes = await member.get("/api/me/notifications")
    expect(notes.json.notifications.some((note: { category: string }) => note.category === "budget")).toBe(true)
    const budgets = await member.get("/api/me/budgets")
    expect(budgets.json.budgets.length).toBe(1)
    expect(budgets.json.budgets[0].forecast_label).toContain("forecast")
    await admin.patch(`/api/admin/budgets/${soft.json.id}`, { enabled: false })
  })

  test("15 a leaked credential is detected and stored only in redacted form", async () => {
    const secret = "AKIAABCDEFGHIJKLMNOP"
    const privateKey = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz\n-----END RSA PRIVATE KEY-----"
    const response = await chat(h.origin, tokens.a!.access_token, {
      model: "mock-chat",
      messages: [{ role: "user", content: `deploy with key ${secret} and\n${privateKey}` }],
    })
    expect(response.status).toBe(200)
    await response.text()
    const events = await h.sql`select category, severity, summary_redacted, evidence from risk_events where user_id = ${ids["member-a"]!} and category = 'secret_leak'`
    expect(events.length).toBe(2)
    const dump = JSON.stringify(events)
    expect(dump).not.toContain(secret)
    expect(dump).not.toContain("MIIEowIBAAKCAQEAxyz")
    expect(dump).toContain("REDACTED")
    // Same secret again: de-duplicated, not a new event.
    await (await chat(h.origin, tokens.a!.access_token, { model: "mock-chat", messages: [{ role: "user", content: `again ${secret}` }] })).text()
    const [count] = await h.sql`select count(*)::int as n from risk_events where user_id = ${ids["member-a"]!} and category = 'secret_leak'`
    expect(count.n).toBe(2)
    // Block mode stops the request before it reaches the upstream.
    expect((await admin.patch("/api/admin/policies/secret_leak", { action: "block" })).status).toBe(200)
    const calls = h.mock.control.calls
    const blocked = await chat(h.origin, tokens.a!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }] })
    expect(blocked.status).toBe(403)
    expect(((await blocked.json()) as any).error.code).toBe("policy_blocked")
    expect(h.mock.control.calls).toBe(calls)
    await admin.patch("/api/admin/policies/secret_leak", { action: "flag" })
    // Heuristic rules can never be switched to blocking.
    expect((await admin.patch("/api/admin/policies/project_relevance", { action: "block" })).status).toBe(422)
    expect(h.logs.join("\n")).not.toContain(secret)
    expect(h.logs.join("\n")).not.toContain(MOCK_KEY)
  })

  test("16 relevance hints are review-only, can be marked false positive, and members can appeal", async () => {
    await admin.patch("/api/admin/policies/project_relevance", { enabled: true, config: { mode: "keyword", min_overlap: 0.05 } })
    const response = await chat(
      h.origin,
      tokens.a!.access_token,
      {
        model: "mock-chat",
        messages: [{ role: "user", content: "Plan my wedding seating chart and write romantic poems for the guests attending the reception dinner party" }],
      },
      { "x-opencode-session-id": "ses_offtopic" },
    )
    expect(response.status).toBe(200)
    await response.text()
    const risk = await eventually(
      async () => (await admin.get("/api/admin/risks?category=project_relevance")).json.risks,
      (risks) => risks.length > 0,
    )
    expect(risk[0].severity).toBe("info")
    const detail = await admin.get(`/api/admin/risks/${risk[0].id}`)
    expect(detail.json.event.evidence.explanation).toContain("hint")
    const member = webClient(h.origin)
    await member.login("member-a", passwords["member-a"]!)
    const mine = await member.get("/api/me/risks")
    expect(mine.json.risks.some((item: { id: string }) => item.id === risk[0].id)).toBe(true)
    expect((await member.post(`/api/me/risks/${risk[0].id}/appeal`, { message: "This was a test prompt for the demo." })).status).toBe(200)
    expect((await admin.post(`/api/admin/risks/${risk[0].id}/review`, { decision: "false_positive", note: "Agreed, demo prompt" })).status).toBe(200)
    const notifications = await member.get("/api/me/notifications")
    expect(notifications.json.notifications.some((item: { category: string }) => item.category === "risk_review")).toBe(true)
    const other = webClient(h.origin)
    await other.login("member-c", passwords["member-c"]!)
    expect((await other.post(`/api/me/risks/${risk[0].id}/appeal`, { message: "not mine to appeal" })).status).toBe(404)
    await admin.patch("/api/admin/policies/project_relevance", { enabled: false })
  })

  test("22 members of the same project only see their own usage", async () => {
    const memberA = webClient(h.origin)
    await memberA.login("member-a", passwords["member-a"]!)
    const usage = await memberA.get(`/api/me/usage?user=${ids["member-b"]}`)
    const requests = await memberA.get(`/api/me/requests?user=${ids["member-b"]}&limit=200`)
    expect(requests.json.items.every((item: { user_id: string }) => item.user_id === ids["member-a"])).toBe(true)
    const [own] = await h.sql`select count(*)::int as n from gateway_requests where user_id = ${ids["member-a"]!}`
    expect(usage.json.summary.requests).toBe(own.n)
  })

  test("12 removal from a project, disabled accounts and revoked sessions stop new calls", async () => {
    expect((await admin.del(`/api/admin/projects/${ids.alpha}/members/${ids["member-b"]}`)).status).toBe(200)
    const removed = await chat(h.origin, tokens.bAlpha!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "x" }] })
    expect(removed.status).toBe(403)
    expect(((await removed.json()) as any).error.code).toBe("project_access_revoked")
    const stillBeta = await chat(h.origin, tokens.bBeta!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "x" }] })
    expect(stillBeta.status).toBe(200)
    await stillBeta.text()

    expect((await admin.post(`/api/admin/users/${ids["member-b"]}/revoke-sessions`, {})).status).toBe(200)
    expect((await chat(h.origin, tokens.bBeta!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "x" }] })).status).toBe(401)

    expect((await admin.patch(`/api/admin/users/${ids["member-c"]}`, { status: "disabled" })).status).toBe(200)
    expect((await chat(h.origin, tokens.c!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "x" }] })).status).toBe(401)
    const login = await webClient(h.origin).login("member-c", passwords["member-c"]!)
    expect(login.status).toBe(401)
    await admin.patch(`/api/admin/users/${ids["member-c"]}`, { status: "active" })
  })

  test("17 refresh tokens rotate and a replayed refresh token revokes the session", async () => {
    const rotate = (refresh: string) =>
      fetch(`${h.origin}/auth/device/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh, client_id: "opencode-cli" }),
      }).then(async (response) => ({ status: response.status, json: (await response.json()) as any }))
    const first = await rotate(tokens.a!.refresh_token)
    expect(first.status).toBe(200)
    expect(first.json.org_id).toBe(ids.alpha)
    expect((await chat(h.origin, tokens.a!.access_token, { model: "mock-chat", messages: [{ role: "user", content: "old" }] })).status).toBe(401)
    const replay = await rotate(tokens.a!.refresh_token)
    expect(replay.status).toBe(400)
    expect((await chat(h.origin, first.json.access_token, { model: "mock-chat", messages: [{ role: "user", content: "new" }] })).status).toBe(401)
  })

  test("17b failed logins lock the account and are audited", async () => {
    const client = webClient(h.origin)
    for (let index = 0; index < 5; index++) expect((await client.login("member-c", "wrong-password")).status).toBe(401)
    expect((await client.login("member-c", passwords["member-c"]!)).status).toBe(423)
    const [row] = await h.sql`select count(*)::int as n from audit_logs where action = 'auth.login_failed'`
    expect(row.n).toBeGreaterThanOrEqual(5)
    expect((await admin.patch(`/api/admin/users/${ids["member-c"]}`, { unlock: true })).status).toBe(200)
    expect((await client.login("member-c", passwords["member-c"]!)).status).toBe(200)
  })

  test("audit log is append-only at the database level", async () => {
    // Bun.SQL queries are lazy thenables; wrap them so expect() observes a real promise.
    await expect((async () => h.sql`update audit_logs set action = 'tampered'`)()).rejects.toThrow("append-only")
    await expect((async () => h.sql`delete from audit_logs`)()).rejects.toThrow("append-only")
  })

  test("CSV export contains requests and never the upstream key", async () => {
    const response = await fetch(`${h.origin}/api/admin/reports/export?type=requests`, { headers: { cookie: admin.cookie } })
    const csv = await response.text()
    expect(response.headers.get("content-type")).toContain("text/csv")
    expect(csv).toContain("request_id")
    expect(csv).toContain("mock-chat")
    expect(csv).not.toContain(MOCK_KEY)
  })

  test("MCP tools give members their own usage inside OpenCode", async () => {
    const login = await deviceLogin(h.origin, members["member-a"]!, ids.alpha!)
    const call = (body: unknown) =>
      fetch(`${h.origin}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${login.token!.access_token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((response) => response.json() as Promise<any>)
    expect((await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).result.serverInfo.name).toBe("saorsa")
    expect((await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).result.tools.length).toBe(2)
    const status = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "saorsa_status", arguments: {} } })
    expect(status.result.content[0].text).toContain("ALPHA")
    const usage = await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "saorsa_usage", arguments: { days: 7 } } })
    expect(usage.result.content[0].text).toContain("Requests:")
  })
})

describe("21 no collaboration entities", () => {
  test("schema contains no repository, task, issue, PR, workspace or agent job tables or columns", async () => {
    const tables = await h.sql`select table_name from information_schema.tables where table_schema = 'public'`
    const names = tables.map((row: { table_name: string }) => row.table_name)
    for (const forbidden of ["repositor", "task", "issue", "pull_request", "workspace", "agent_job"])
      expect(names.some((name: string) => name.includes(forbidden))).toBe(false)
    const columns = await h.sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'projects'`
    expect(columns.some((row: { column_name: string }) => /repo|git|url/.test(row.column_name))).toBe(false)
  })
})
