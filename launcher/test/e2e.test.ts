import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MOCK_KEY } from "../../server/src/mock-upstream.js"
import { seedOrg, startHarness, type Harness } from "../../server/test/harness.js"

// The Launcher binary entry point against the real Saorsa server (fresh test database, TEST mock upstream).
// A fake `claude` on PATH stands in for the real CLI so the test can inspect exactly what a launched tool
// receives; server/test/lab.test.ts runs the real CLIs.

let h: Harness
let org: Awaited<ReturnType<typeof seedOrg>>
let root = ""
let workspace = ""
let fakeBin = ""
const main = path.join(import.meta.dir, "..", "src", "main.ts")

/** One device = its own SAORSA_HOME and credential file. */
const device = (name: string) => ({
  SAORSA_HOME: path.join(root, name),
  SAORSA_SECRET_FILE: path.join(root, name, "credential"),
  SAORSA_NO_BROWSER: "1",
  SAORSA_GEMINI_SETTINGS: path.join(root, name, "home", ".gemini", "settings.json"),
})

async function saorsa(args: string[], env: Record<string, string>, onOutput?: (text: string) => Promise<void>) {
  const child = Bun.spawn(["bun", main, ...args], {
    cwd: workspace,
    env: { PATH: `${fakeBin}:${process.env.PATH}`, HOME: path.join(root, "home"), ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let output = ""
  const decoder = new TextDecoder()
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    for await (const chunk of stream) {
      output += decoder.decode(chunk)
      await onOutput?.(output)
    }
  }
  await Promise.all([pump(child.stdout), pump(child.stderr)])
  return { code: await child.exited, output }
}

/** Runs `saorsa login` and approves it in the browser flow as the seed member. */
async function login(env: Record<string, string>, label: string) {
  let approved = false
  const result = await saorsa(["login", "--server", h.origin, "--label", label], env, async (output) => {
    const code = /验证码 ([A-Z0-9-]+)/.exec(output)?.[1]
    if (!code || approved) return
    approved = true
    const approval = await org.members[0]!.client.post("/api/device/approve", { userCode: code, projectID: org.projectID, acknowledgeNotice: true })
    expect(approval.status).toBe(200)
  })
  expect({ code: result.code, approved }).toEqual({ code: 0, approved: true })
  return result
}

beforeAll(async () => {
  h = await startHarness()
  org = await seedOrg(h, { singleDeviceLogin: true })
  const anthropic = (await org.admin.post("/api/admin/providers", { name: "Mock Anthropic (TEST)", protocol: "anthropic-messages", baseURL: h.mock.url })).json.id
  await org.admin.post(`/api/admin/providers/${anthropic}/credentials`, { label: "primary", apiKey: MOCK_KEY })
  const claude = (await org.admin.post("/api/admin/models", { providerID: anthropic, upstreamModel: "claude-mock", alias: "claude-mock", displayName: "Claude (TEST)", defaultMaxOutput: 64, price: { input: "1", output: "2" } })).json.id
  await org.admin.put(`/api/admin/projects/${org.projectID}/models`, { modelIDs: [org.modelID, claude] })
  await org.admin.put(`/api/admin/projects/${org.projectID}/tools`, { toolIDs: ["opencode", "claude-code", "gemini-cli", "cursor"] })

  root = await mkdtemp(path.join(tmpdir(), "saorsa-launcher-e2e-"))
  workspace = path.join(root, "project")
  fakeBin = path.join(root, "bin")
  await mkdir(workspace, { recursive: true })
  await mkdir(fakeBin, { recursive: true })
  // Fake Claude Code: reports a version, proves no personal key leaked, keeps the token for the revocation
  // checks below, and makes one gateway call with exactly what it was given.
  await writeFile(
    path.join(fakeBin, "claude"),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi
[ -n "$ANTHROPIC_API_KEY" ] && echo "PERSONAL KEY LEAKED"
printf '%s' "$ANTHROPIC_AUTH_TOKEN" > "${root}/launched-token"
echo "args: $*"
echo "model: $ANTHROPIC_MODEL"
curl -s -X POST "$ANTHROPIC_BASE_URL/v1/messages" -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" -H "anthropic-version: 2023-06-01" \\
  -H "content-type: application/json" -H "user-agent: claude-cli/9.9.9 (external, cli)" \\
  -d "{\\"model\\":\\"$ANTHROPIC_MODEL\\",\\"max_tokens\\":16,\\"messages\\":[{\\"role\\":\\"user\\",\\"content\\":\\"hi\\"}]}"
`,
  )
  await chmod(path.join(fakeBin, "claude"), 0o755)
})

afterAll(async () => {
  await h.stop()
})

const gateway = (token: string) => fetch(`${h.origin}/gateway/v1/models`, { headers: { authorization: `Bearer ${token}` } }).then((response) => response.status)

describe("Saorsa Launcher", () => {
  test("logs in through the browser device flow and stores the token only in the credential store", async () => {
    await login(device("mac"), "test-mac")
    const config = JSON.parse(await readFile(path.join(root, "mac", "config.json"), "utf8"))
    expect(config).toMatchObject({ server: h.origin, deviceLabel: "test-mac", defaultProjectID: org.projectID })
    expect(JSON.stringify(config)).not.toContain("tos_at_")
    expect(await readFile(path.join(root, "mac", "credential"), "utf8")).toMatch(/^tos_at_/)
    const status = await saorsa(["status"], device("mac"))
    expect(status.output).toContain("SEED")
    expect(status.output).toContain("Claude Code")
  })

  test("detects tools locally and reports them per device, without paths or file contents", async () => {
    const result = await saorsa(["tools"], device("mac"))
    expect(result.code).toBe(0)
    expect(result.output).toMatch(/claude-code\s+已安装 9\.9\.9/)
    const rows = (await org.admin.get("/api/admin/installations")).json.installations as Array<Record<string, unknown>>
    expect(rows.length).toBe(12)
    expect(rows.find((row) => row.tool_id === "claude-code")).toMatchObject({ installed: true, version: "9.9.9", device_label: "test-mac" })
    expect(JSON.stringify(rows)).not.toContain(fakeBin)
    const available = (await org.admin.get("/api/admin/tools")).json.tools.find((tool: { id: string }) => tool.id === "claude-code")
    expect(available.status.available).toBe(true)
  })

  test("launches a tool with a short-lived, tool-bound token in its environment only", async () => {
    const result = await saorsa(["launch", "claude-code", "--yes", "--dir", workspace, "--", "-p", "hello"], { ...device("mac"), ANTHROPIC_API_KEY: "sk-personal-should-not-pass" })
    expect(result.code).toBe(0)
    expect(result.output).not.toContain("PERSONAL KEY LEAKED")
    expect(result.output).toContain("args: -p hello")
    expect(result.output).toContain("model: claude-mock")
    expect(result.output).toContain("Hello from the mock Anthropic upstream")
    const [row] = await h.sql`select r.tool_id, r.tool_version, r.billing_status, s.parent_session_id is not null as child, s.expires_at < now() + interval '13 hours' as short_lived
      from gateway_requests r join user_sessions s on s.id = r.client_session_id order by r.started_at desc limit 1`
    expect(row).toEqual({ tool_id: "claude-code", tool_version: "9.9.9", billing_status: "exact", child: true, short_lived: true })
    const events = await h.sql`select action, outcome, tool_id from launcher_events order by created_at`
    expect(events.some((event: { action: string; outcome: string }) => event.action === "launch" && event.outcome === "succeeded")).toBe(true)
    const log = await readFile(path.join(root, "mac", "logs", "launcher.log"), "utf8")
    expect(log).not.toContain("tos_at_")
  })

  test("refuses an action in a non-interactive run without --yes", async () => {
    const result = await saorsa(["launch", "claude-code", "--dir", workspace], device("mac"))
    expect(result.output).toContain("--yes")
    expect(result.output).not.toContain("Hello from the mock")
  })

  test("IDE tools get their official download page and settings, never an automatic install", async () => {
    const install = await saorsa(["install", "cursor", "--yes"], device("mac"))
    expect(install.output).toContain("https://cursor.com/downloads")
    const configure = await saorsa(["configure", "cursor"], device("mac"))
    expect(configure.output).toContain(`${h.origin}/gateway/v1`)
    const key = await saorsa(["configure", "cursor", "--key", "--project", "SEED", "--yes"], device("mac"))
    const issued = /tos_at_[\w-]+/.exec(key.output)?.[0]
    expect(issued).toBeDefined()
    expect(await gateway(issued!)).toBe(200)
  })

  test("Gemini CLI configuration changes one setting with a backup and restores it", async () => {
    const settings = path.join(root, "mac", "home", ".gemini", "settings.json")
    await mkdir(path.dirname(settings), { recursive: true })
    await writeFile(settings, JSON.stringify({ theme: "dark" }))
    expect((await saorsa(["configure", "gemini-cli", "--yes"], device("mac"))).code).toBe(0)
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ theme: "dark", security: { auth: { selectedType: "gemini-api-key" } } })
    expect((await saorsa(["restore", "gemini-cli"], device("mac"))).output).toContain("已恢复")
    expect(JSON.parse(await readFile(settings, "utf8"))).toEqual({ theme: "dark" })
  })

  test("signing in on another device ends this Launcher and every tool token it issued", async () => {
    const launched = await readFile(path.join(root, "launched-token"), "utf8")
    expect(await gateway(launched)).toBe(200)
    await login(device("windows-pc"), "test-pc")
    const stale = await saorsa(["status"], device("mac"))
    expect(stale.code).toBe(1)
    expect(stale.output).toContain("saorsa login")
    expect(await gateway(launched)).toBe(401)
    expect((await saorsa(["status"], device("windows-pc"))).code).toBe(0)
  })

  test("logout revokes the session on the server and deletes the local credential", async () => {
    const before = await readFile(path.join(root, "windows-pc", "credential"), "utf8")
    expect((await saorsa(["logout"], device("windows-pc"))).code).toBe(0)
    expect(await readFile(path.join(root, "windows-pc", "credential"), "utf8").catch(() => "deleted")).toBe("deleted")
    const response = await fetch(`${h.origin}/api/launcher/me`, { headers: { authorization: `Bearer ${before}` } })
    expect(response.status).toBe(401)
  })
})
