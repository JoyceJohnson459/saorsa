/**
 * DEMO / DEVELOPMENT SETUP — never run against production.
 * Initializes a running Saorsa server through its public API with an admin, two project groups, three
 * members and the clearly-labelled mock upstream provider. Passwords are random and written once to
 * .data/dev-credentials.json (git-ignored, mode 600); nothing weak or hardcoded is created.
 *
 *   bun scripts/dev-setup.ts            (reads .env, server must be running)
 */
import { randomBytes } from "node:crypto"
import { chmod, mkdir } from "node:fs/promises"
import path from "node:path"

const root = path.join(import.meta.dir, "..")
const origin = process.env.SAORSA_PUBLIC_URL ?? process.env.NEXCODE_PUBLIC_URL ?? process.env.TEAMOS_PUBLIC_URL ?? "http://127.0.0.1:8787"
const bootstrapToken = process.env.SAORSA_BOOTSTRAP_TOKEN ?? process.env.NEXCODE_BOOTSTRAP_TOKEN ?? process.env.TEAMOS_BOOTSTRAP_TOKEN
const mockURL = process.env.MOCK_UPSTREAM_URL ?? "http://127.0.0.1:18080/v1"
const mockKey = "mock-upstream-test-key-not-a-secret"
if (!bootstrapToken) throw new Error("SAORSA_BOOTSTRAP_TOKEN is required (bun loads .env automatically when run from the repository root)")

const password = () => `Dv!${randomBytes(12).toString("base64url")}9a`
let cookie = ""
async function api(method: string, route: string, body?: unknown) {
  const response = await fetch(`${origin}${route}`, {
    method,
    headers: { "content-type": "application/json", "x-teamos-csrf": "1", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const setCookie = response.headers.get("set-cookie")
  if (setCookie) cookie = setCookie.split(";")[0]!
  const json = (await response.json().catch(() => ({}))) as any
  if (!response.ok) throw new Error(`${method} ${route} → ${response.status} ${JSON.stringify(json)}`)
  return json
}

const status = await api("GET", "/api/auth/status")
if (status.initialized) {
  console.log("Saorsa is already initialized; nothing to do.")
  process.exit(0)
}
const credentials: Record<string, string> = { admin: password() }
await api("POST", "/api/auth/bootstrap", {
  token: bootstrapToken,
  organization: "Saorsa Demo (DEV)",
  timezone: "Asia/Shanghai",
  username: "admin",
  displayName: "Administrator",
  password: credentials.admin,
})
await api("POST", "/api/auth/login", { username: "admin", password: credentials.admin })
const vision = await api("POST", "/api/admin/projects", {
  code: "VISION",
  name: "视觉质检",
  purpose: "工业视觉缺陷检测：图像预处理、模型训练与推理服务开发 (defect detection, image preprocessing, model training, inference service)",
  tags: ["vision", "pytorch"],
})
const ledger = await api("POST", "/api/admin/projects", {
  code: "LEDGER",
  name: "财务台账",
  purpose: "财务台账后端与报表服务开发 (accounting ledger backend, reporting API)",
  tags: ["backend"],
})
for (const [username, displayName, projects] of [
  ["alice", "Alice (DEMO)", [vision.id]],
  ["bob", "Bob (DEMO)", [vision.id, ledger.id]],
  ["carol", "Carol (DEMO)", [ledger.id]],
] as const) {
  credentials[username] = password()
  await api("POST", "/api/admin/users", { username, displayName, password: credentials[username], projectIDs: projects })
}
const provider = await api("POST", "/api/admin/providers", { name: "Mock Upstream (TEST ONLY)", protocol: "openai-chat", baseURL: mockURL })
await api("POST", `/api/admin/providers/${provider.id}/credentials`, { label: "mock key (test)", apiKey: mockKey })
const model = await api("POST", "/api/admin/models", {
  providerID: provider.id,
  upstreamModel: "mock-chat",
  alias: "mock-chat",
  displayName: "Mock Chat (TEST)",
  contextLimit: 128000,
  outputLimit: 8192,
  defaultMaxOutput: 2048,
  price: { currency: "USD", input: "3", output: "15", cacheRead: "0.3", source: "demo price" },
})
for (const project of [vision, ledger]) await api("PUT", `/api/admin/projects/${project.id}/models`, { modelIDs: [model.id] })
await api("POST", "/api/admin/budgets", { scopeType: "project", projectID: vision.id, period: "monthly", limit: "50" })
await api("POST", "/api/admin/budgets", { scopeType: "project", projectID: ledger.id, period: "monthly", limit: "20" })

await mkdir(path.join(root, ".data"), { recursive: true })
const file = path.join(root, ".data", "dev-credentials.json")
await Bun.write(file, JSON.stringify({ origin, note: "DEV ONLY - members must change these on first login", ...credentials }, null, 2))
await chmod(file, 0o600)
console.log(`Demo organization created. Credentials written to ${file}`)
