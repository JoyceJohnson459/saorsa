import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { MOCK_KEY } from "../src/mock-upstream.js"
import { chat, deviceLogin, seedOrg, startHarness, webClient, type Harness, type WebClient } from "./harness.js"

// Product defaults: exclusive keys (n keys = n members working at once, first come first served) and
// single-device login (a new login on a channel signs that channel out on other devices).

let h: Harness
let org: Awaited<ReturnType<typeof seedOrg>>
let kimiProviderID = ""
const MEMBER_PASSWORD = "Zx9!Correct-Horse-7"

const call = (token: string, model: string) => chat(h.origin, token, { model, messages: [{ role: "user", content: "hi" }] })
const member = (index: number) => org.members[index]!
const keys = (client: WebClient) => client.get("/api/me/keys").then((response) => response.json)
const pool = (body: { pools: Array<{ id: string; total: number; free: number; mine: boolean }> }, id: string) =>
  body.pools.find((entry) => entry.id === id)

beforeAll(async () => {
  h = await startHarness()
  org = await seedOrg(h, { members: 3, keyAssignment: "exclusive", singleDeviceLogin: true })
  kimiProviderID = (await org.admin.post("/api/admin/providers", { name: "Mock Kimi (TEST)", protocol: "openai-chat", baseURL: h.mock.url })).json.id
  for (const label of ["kimi-1", "kimi-2"]) await org.admin.post(`/api/admin/providers/${kimiProviderID}/credentials`, { label, apiKey: MOCK_KEY })
  const kimiModel = (
    await org.admin.post("/api/admin/models", {
      providerID: kimiProviderID,
      upstreamModel: "mock-chat",
      alias: "kimi-chat",
      displayName: "Kimi Chat",
      defaultMaxOutput: 256,
      price: { input: "1", output: "2" },
    })
  ).json.id
  await org.admin.put(`/api/admin/projects/${org.projectID}/models`, { modelIDs: [org.modelID, kimiModel] })
})

afterAll(async () => {
  await h.stop()
})

describe("exclusive keys", () => {
  test("each key serves one member; the first to call claims it and the rest are pointed at free keys", async () => {
    const first = await call(member(0).token, "mock-chat")
    expect(first.status).toBe(200)
    await first.text()

    const blocked = await call(member(1).token, "mock-chat")
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get("x-should-retry")).toBe("false")
    const error = ((await blocked.json()) as { error: { code: string; message: string } }).error
    expect(error.code).toBe("no_free_key")
    expect(error.message).toContain("Mock Kimi (TEST)(2)")

    for (const index of [1, 2]) {
      const response = await call(member(index).token, "kimi-chat")
      expect(response.status).toBe(200)
      await response.text()
    }
    const rows = await h.sql`select user_id, credential_id from gateway_requests where status = 'succeeded' order by started_at`
    const credentialOf = (index: number) => rows.find((row: { user_id: string }) => row.user_id === member(index).id)?.credential_id
    expect(new Set([credentialOf(0), credentialOf(1), credentialOf(2)]).size).toBe(3)

    const view = await keys(member(0).client)
    expect(view.mode).toBe("exclusive")
    expect(pool(view, org.providerID)).toMatchObject({ total: 1, free: 0, mine: true })
    expect(pool(view, kimiProviderID)).toMatchObject({ total: 2, free: 0, mine: false })
  })

  test("a member only moves to another provider when it has a free key, and keeps their own meanwhile", async () => {
    const moved = await call(member(0).token, "kimi-chat")
    expect(moved.status).toBe(429)
    await moved.text()
    expect(pool(await keys(member(0).client), org.providerID)).toMatchObject({ free: 0, mine: true })

    expect((await member(1).client.post("/api/me/keys/release")).status).toBe(200)
    expect(pool(await keys(member(0).client), kimiProviderID)).toMatchObject({ free: 1 })
    expect((await member(0).client.post("/api/me/keys/claim", { providerID: kimiProviderID })).status).toBe(200)
    const after = await keys(member(0).client)
    expect(pool(after, kimiProviderID)).toMatchObject({ free: 0, mine: true })
    expect(pool(after, org.providerID)).toMatchObject({ free: 1, mine: false })

    const full = await member(1).client.post("/api/me/keys/claim", { providerID: kimiProviderID })
    expect(full.status).toBe(429)
    const freed = await call(member(1).token, "mock-chat")
    expect(freed.status).toBe(200)
    await freed.text()
  })

  test("idle leases expire, logging out frees the key, and admins see and release holders", async () => {
    await h.sql`update credential_leases set last_used_at = now() - interval '31 minutes' where user_id = ${member(1).id}`
    expect(pool(await keys(member(2).client), org.providerID)).toMatchObject({ free: 1 })

    const providers = (await org.admin.get("/api/admin/providers")).json.providers as Array<{
      id: string
      credentials: Array<{ id: string; lease: { username: string } | null }>
    }>
    const held = providers.find((provider) => provider.id === kimiProviderID)!.credentials.find((credential) => credential.lease)!
    expect(["member-1", "member-3"]).toContain(held.lease!.username)
    expect((await org.admin.del(`/api/admin/key-leases/${held.id}`)).status).toBe(200)
    expect((await org.admin.del(`/api/admin/key-leases/${held.id}`)).status).toBe(404)
    const holder = held.lease!.username === "member-1" ? member(0) : member(2)
    expect((await holder.client.get("/api/me/notifications")).json.notifications[0].title).toContain("释放")

    const sessions = (await member(2).client.get("/api/me/sessions")).json.sessions as Array<{ id: string; kind: string }>
    await member(2).client.del(`/api/me/sessions/${sessions.find((session) => session.kind === "client")!.id}`)
    // Any availability read expires leases whose holder no longer has an OpenCode login.
    expect((await keys(member(0).client)).pools.length).toBe(2)
    const [after] = await h.sql`select count(*)::int as n from credential_leases where user_id = ${member(2).id}`
    expect(after.n).toBe(0)
  })

  test("members racing for the same keys get exactly one key each, never a shared one", async () => {
    await h.sql`delete from credential_leases`
    const racers = await Promise.all(
      ["racer-1", "racer-2", "racer-3", "racer-4"].map(async (username) => {
        await org.admin.post("/api/admin/users", { username, displayName: username, password: MEMBER_PASSWORD, projectIDs: [org.projectID] })
        const client = webClient(h.origin)
        await client.login(username, MEMBER_PASSWORD)
        return (await deviceLogin(h.origin, client, org.projectID)).token!.access_token
      }),
    )
    const statuses = await Promise.all(
      racers.flatMap((token) => [call(token, "kimi-chat"), call(token, "kimi-chat")]).map(async (response) => {
        const result = await response
        await result.text()
        return result.status
      }),
    )
    const leases = await h.sql`select credential_id from credential_leases where provider_id = ${kimiProviderID}`
    expect(leases.length).toBe(2)
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(2)
    expect(statuses.every((status) => status === 200 || status === 429)).toBe(true)
    const served = await h.sql`select r.user_id, count(distinct r.credential_id)::int as keys from gateway_requests r
      join users u on u.id = r.user_id where u.username like 'racer-%' and r.status = 'succeeded' group by r.user_id`
    expect(served.length).toBe(2)
    expect(served.every((row: { keys: number }) => row.keys === 1)).toBe(true)
  })

  test("shared mode serves every member from every key", async () => {
    await org.admin.patch("/api/admin/settings", { keyAssignment: "shared" })
    for (const index of [0, 1]) {
      const response = await call(member(index).token, "mock-chat")
      expect(response.status).toBe(200)
      await response.text()
    }
    expect((await member(0).client.post("/api/me/keys/claim", { providerID: kimiProviderID })).status).toBe(409)
    await org.admin.patch("/api/admin/settings", { keyAssignment: "exclusive" })
  })
})

describe("single-device login", () => {
  test("a web login on device B signs device A out immediately, with a reason", async () => {
    const deviceA = webClient(h.origin)
    await deviceA.login("member-2", MEMBER_PASSWORD)
    const stream = await fetch(`${h.origin}/api/me/events`, { headers: { cookie: deviceA.cookie } })
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    let text = ""
    while (!text.includes("event: ready")) text += decoder.decode((await reader.read()).value)

    const deviceB = webClient(h.origin)
    expect((await deviceB.login("member-2", MEMBER_PASSWORD)).status).toBe(200)
    while (!text.includes("event: session.ended")) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value)
    }
    expect(text).toContain("event: session.ended")
    const kicked = await deviceA.get("/api/me")
    expect(kicked.status).toBe(401)
    expect(kicked.json.error.code).toBe("session_replaced")
    expect((await deviceB.get("/api/me")).status).toBe(200)
    member(1).client = deviceB
  })

  test("an OpenCode login on device B signs OpenCode out on device A but keeps the web session and the key", async () => {
    const before = await call(member(1).token, "mock-chat")
    expect(before.status).toBe(200)
    await before.text()
    const login = await deviceLogin(h.origin, member(1).client, org.projectID)
    expect(login.token).toBeDefined()

    const old = await call(member(1).token, "mock-chat")
    expect(old.status).toBe(401)
    expect(((await old.json()) as { error: { message: string } }).error.message).toContain("其他设备")
    const config = await fetch(`${h.origin}/api/opencode/config`, { headers: { authorization: `Bearer ${member(1).token}` } })
    expect(JSON.stringify(await config.json())).toContain("其他设备")

    expect((await member(1).client.get("/api/me")).status).toBe(200)
    expect(pool(await keys(member(1).client), org.providerID)).toMatchObject({ mine: true })
    const fresh = await call(login.token!.access_token, "mock-chat")
    expect(fresh.status).toBe(200)
    await fresh.text()
  })

  test("turning it off allows several devices again", async () => {
    await org.admin.patch("/api/admin/settings", { singleDeviceLogin: false })
    const second = webClient(h.origin)
    await second.login("member-2", MEMBER_PASSWORD)
    expect((await member(1).client.get("/api/me")).status).toBe(200)
    expect((await second.get("/api/me")).status).toBe(200)
  })
})
