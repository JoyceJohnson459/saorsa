import { RedisClient } from "bun"
import { randomBytes } from "node:crypto"
import { createApp } from "../src/app.js"
import { SecretBox } from "../src/crypto.js"
import { connect, migrate } from "../src/db.js"
import { loadEnv } from "../src/env.js"
import { createLogger } from "../src/log.js"
import { createRealtime } from "../src/realtime.js"
import { createLimiter } from "../src/ratelimit.js"
import { startMockUpstream } from "../src/mock-upstream.js"

export const BOOTSTRAP_TOKEN = randomBytes(24).toString("base64url")
const DATABASE_URL = process.env.TEAMOS_TEST_DATABASE_URL ?? "postgres://teamos@127.0.0.1:55432/teamos_test"
const REDIS_URL = process.env.TEAMOS_TEST_REDIS_URL ?? "redis://127.0.0.1:56379/1"

export async function startHarness() {
  const sql = connect(DATABASE_URL)
  // Tests own this database: start from an empty schema every run.
  await sql.unsafe("drop schema public cascade; create schema public;")
  await migrate(sql)
  const redis = new RedisClient(REDIS_URL)
  await redis.send("FLUSHDB", [])
  const mock = startMockUpstream()
  const logs: string[] = []
  const env = loadEnv({
    TEAMOS_DATABASE_URL: DATABASE_URL,
    TEAMOS_REDIS_URL: REDIS_URL,
    TEAMOS_MASTER_KEYS: `1:${randomBytes(32).toString("base64")}`,
    TEAMOS_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    TEAMOS_ALLOW_PRIVATE_UPSTREAMS: "true",
    TEAMOS_PUBLIC_URL: "http://127.0.0.1:1",
    TEAMOS_LOG_LEVEL: "debug",
  })
  const base = createLogger("debug")
  // Capture every log line so tests can assert secrets never reach logs.
  const log = Object.fromEntries(
    (["debug", "info", "warn", "error"] as const).map((level) => [
      level,
      (message: string, fields?: Record<string, unknown>) => {
        logs.push(JSON.stringify({ level, message, fields }))
        if (level === "error") base.error(message, fields)
      },
    ]),
  ) as ReturnType<typeof createLogger>
  const deps = {
    sql,
    redis,
    env,
    box: new SecretBox(env.TEAMOS_MASTER_KEYS, env.TEAMOS_MASTER_KEY_ACTIVE),
    realtime: await createRealtime(redis, log),
    limiter: createLimiter(redis),
    log,
    fetch: globalThis.fetch,
  }
  const app = createApp(deps)
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 60 })
  const origin = `http://127.0.0.1:${server.port}`
  // The public URL feeds remote config; point it at the live test server.
  ;(env as { TEAMOS_PUBLIC_URL: string }).TEAMOS_PUBLIC_URL = origin
  return {
    sql,
    redis,
    deps,
    mock,
    logs,
    origin,
    async stop() {
      server.stop(true)
      mock.server.stop(true)
      await deps.realtime.close()
      redis.close()
      await sql.close()
    },
  }
}

export type Harness = Awaited<ReturnType<typeof startHarness>>

/** Minimal cookie-aware client for the web API. */
export function webClient(origin: string) {
  let cookie = ""
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        "x-teamos-csrf": "1",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const setCookie = response.headers.get("set-cookie")
    if (setCookie) cookie = setCookie.split(";")[0]!
    const text = await response.text()
    let json: any
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    return { status: response.status, json, headers: response.headers, text }
  }
  return {
    call,
    get: (path: string) => call("GET", path),
    post: (path: string, body?: unknown) => call("POST", path, body ?? {}),
    patch: (path: string, body: unknown) => call("PATCH", path, body),
    put: (path: string, body: unknown) => call("PUT", path, body),
    del: (path: string) => call("DELETE", path),
    login: async (username: string, password: string) => call("POST", "/api/auth/login", { username, password }),
    get cookie() {
      return cookie
    },
  }
}

export type WebClient = ReturnType<typeof webClient>

/** Runs the OpenCode device flow exactly as the stock client does, approving it via the member's web session. */
export async function deviceLogin(origin: string, member: WebClient, projectID: string) {
  const start = await fetch(`${origin}/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: "opencode-cli", supports_org_scope: true }),
  }).then((response) => response.json() as Promise<Record<string, any>>)
  const pending = await poll(origin, start.device_code)
  if (pending.error !== "authorization_pending") throw new Error(`expected pending, got ${JSON.stringify(pending)}`)
  const approve = await member.post("/api/device/approve", { userCode: start.user_code, projectID, acknowledgeNotice: true })
  if (approve.status !== 200) return { approve, token: undefined }
  const token = await poll(origin, start.device_code)
  return { approve, token: token as { access_token: string; refresh_token: string; org_id: string }, start }
}

async function poll(origin: string, deviceCode: string) {
  const response = await fetch(`${origin}/auth/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: deviceCode, client_id: "opencode-cli" }),
  })
  return (await response.json()) as Record<string, any>
}

export async function chat(
  origin: string,
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return fetch(`${origin}/gateway/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

/** Waits for async settlement (streams finalize after the last byte is read). */
export async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean, timeout = 3000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (check(value)) return value
    if (Date.now() > deadline) return value
    await Bun.sleep(25)
  }
}

/**
 * Seeds an initialized org with one project, `members` member accounts, and the mock upstream registered as an
 * OpenAI-compatible provider with a priced, authorized model. Returns the admin client, ids and member tokens.
 */
/**
 * Seeds an organization. Suites written for shared keys and multi-device logins keep those modes by default;
 * keys.test.ts opts into the product defaults (exclusive keys, single-device login).
 */
export async function seedOrg(
  h: Harness,
  options: { members?: number; projectCode?: string; keyAssignment?: "exclusive" | "shared"; singleDeviceLogin?: boolean } = {},
) {
  const { MOCK_KEY } = await import("../src/mock-upstream.js")
  const admin = webClient(h.origin)
  const password = "Adm1n!Strong-Passphrase"
  await admin.post("/api/auth/bootstrap", { token: BOOTSTRAP_TOKEN, organization: "Seed Org", username: "root-admin", displayName: "Root", password })
  await admin.login("root-admin", password)
  await admin.patch("/api/admin/settings", { keyAssignment: options.keyAssignment ?? "shared", singleDeviceLogin: options.singleDeviceLogin ?? false })
  const projectID = (await admin.post("/api/admin/projects", { code: options.projectCode ?? "SEED", name: "Seed Project", purpose: "image preprocessing pipeline" })).json.id as string
  const providerID = (await admin.post("/api/admin/providers", { name: "Mock OpenAI (TEST)", protocol: "openai-chat", baseURL: h.mock.url })).json.id as string
  await admin.post(`/api/admin/providers/${providerID}/credentials`, { label: "primary", apiKey: MOCK_KEY })
  const modelID = (
    await admin.post("/api/admin/models", {
      providerID,
      upstreamModel: "mock-chat",
      alias: "mock-chat",
      displayName: "Mock Chat",
      defaultMaxOutput: 256,
      price: { input: "1", output: "2" },
    })
  ).json.id as string
  await admin.put(`/api/admin/projects/${projectID}/models`, { modelIDs: [modelID] })
  const members: Array<{ id: string; username: string; token: string; client: WebClient }> = []
  for (let index = 0; index < (options.members ?? 1); index++) {
    const username = `member-${index + 1}`
    const created = await admin.post("/api/admin/users", { username, displayName: username, password: "Zx9!Correct-Horse-7", projectIDs: [projectID] })
    const client = webClient(h.origin)
    await client.login(username, "Zx9!Correct-Horse-7")
    const login = await deviceLogin(h.origin, client, projectID)
    members.push({ id: created.json.id, username, token: login.token!.access_token, client })
  }
  return { admin, projectID, providerID, modelID, members }
}
