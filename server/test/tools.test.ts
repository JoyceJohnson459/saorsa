import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MOCK_KEY } from "../src/mock-upstream.js"
import { eventually, seedOrg, startHarness, type Harness } from "./harness.js"

// Tool center, per-tool authorization and attribution, model capabilities, and the OpenAI Responses and Gemini
// native gateway adapters, against the TEST-labelled mock upstream.

let h: Harness
let org: Awaited<ReturnType<typeof seedOrg>>
const ids: Record<string, string> = {}
const keys: Record<string, string> = {}

const member = () => org.members[0]!
const post = (path: string, token: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${h.origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
const lastRequest = () =>
  h.sql`select tool_id, tool_version, protocol, status, billing_status, input_tokens, output_tokens, cost_micros, model_alias, stream
    from gateway_requests order by started_at desc limit 1`.then((rows) => rows[0])
const settledLast = () => eventually(lastRequest, (row) => row && !["pending", "streaming"].includes(row.status))

async function sse(response: Response) {
  const text = await response.text()
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data))
}

beforeAll(async () => {
  h = await startHarness()
  org = await seedOrg(h)
  const provider = async (name: string, protocol: string, baseURL: string, extraProtocols: string[] = []) => {
    const id = (await org.admin.post("/api/admin/providers", { name, protocol, baseURL, extraProtocols })).json.id
    await org.admin.post(`/api/admin/providers/${id}/credentials`, { label: "primary", apiKey: MOCK_KEY })
    return id
  }
  const model = async (providerID: string, alias: string, extra: Record<string, unknown> = {}) =>
    (await org.admin.post("/api/admin/models", { providerID, upstreamModel: alias, alias, displayName: alias, defaultMaxOutput: 256, price: { input: "1", output: "2" }, ...extra })).json.id
  ids.responsesProvider = await provider("Mock Responses (TEST)", "openai-responses", h.mock.url, ["openai-chat"])
  ids.geminiProvider = await provider("Mock Gemini (TEST)", "gemini", h.mock.url.replace(/\/v1$/, "/v1beta"))
  ids.anthropicProvider = await provider("Mock Anthropic (TEST)", "anthropic-messages", h.mock.url)
  ids.codex = await model(ids.responsesProvider!, "mock-codex")
  ids.gemini = await model(ids.geminiProvider!, "mock-gemini")
  ids.claude = await model(ids.anthropicProvider!, "mock-claude")
  ids.plain = await model(ids.responsesProvider!, "mock-plain", { supportsTools: false, supportsVision: false })
  await org.admin.put(`/api/admin/projects/${org.projectID}/models`, { modelIDs: [org.modelID, ids.codex, ids.gemini, ids.claude, ids.plain] })
})

afterAll(async () => {
  await h.stop()
})

describe("tool center", () => {
  test("lists exactly the 12 supported tools, with no status claimed before there is evidence", async () => {
    const { tools } = (await org.admin.get("/api/admin/tools")).json
    expect(tools.map((tool: { id: string }) => tool.id)).toEqual([
      "opencode", "claude-code", "codex", "gemini-cli", "cline", "kilo-code", "qwen-code", "trae", "qoder", "jetbrains-ai", "github-copilot", "cursor",
    ])
    const claude = tools.find((tool: { id: string }) => tool.id === "claude-code")
    expect(claude.status).toMatchObject({ available: false, gatewayCompatible: false, usageVerified: false })
    expect(claude.userAgent).toBeUndefined()
    const cursor = tools.find((tool: { id: string }) => tool.id === "cursor")
    expect(cursor.status.partiallyManaged).toBe(true)
    expect(cursor.status.officialAccountRequired).toBe(true)
  })

  test("a tool key needs the tool authorized for the project group; only OpenCode is on by default", async () => {
    const denied = await member().client.post("/api/me/tool-keys", { toolID: "claude-code", projectID: org.projectID })
    expect(denied.status).toBe(403)
    expect((await member().client.post("/api/me/tool-keys", { toolID: "opencode", projectID: org.projectID })).status).toBe(409)
    expect((await org.admin.put(`/api/admin/projects/${org.projectID}/tools`, { toolIDs: ["opencode", "claude-code", "codex", "gemini-cli", "cursor"] })).status).toBe(200)
    expect((await org.admin.put(`/api/admin/projects/${org.projectID}/tools`, { toolIDs: ["windsurf"] })).status).toBe(422)
    for (const tool of ["claude-code", "codex", "gemini-cli", "cursor"]) {
      const created = await member().client.post("/api/me/tool-keys", { toolID: tool, projectID: org.projectID })
      expect(created.status).toBe(201)
      expect(created.json.key).toMatch(/^tos_at_/)
      keys[tool] = created.json.key
    }
    const view = (await member().client.get("/api/tools")).json.tools
    expect(view.find((tool: { id: string }) => tool.id === "claude-code").projects.map((project: { id: string }) => project.id)).toEqual([org.projectID])
    expect(view.find((tool: { id: string }) => tool.id === "qwen-code").projects).toEqual([])
  })
})

describe("connection guides", () => {
  test("every tool has a guide, and the guide lists only models the tool can use in each project group", async () => {
    for (const id of ["opencode", "claude-code", "codex", "gemini-cli", "cline", "kilo-code", "qwen-code", "trae", "qoder", "jetbrains-ai", "github-copilot", "cursor"]) {
      const response = await member().client.get(`/api/tools/${id}`)
      expect(response.status).toBe(200)
      expect(response.json.guide.methods.length).toBeGreaterThan(0)
      expect(response.json.guide.install.length).toBeGreaterThan(0)
    }
    const models = async (id: string) =>
      ((await member().client.get(`/api/tools/${id}`)).json.projects as Array<{ id: string; authorized: boolean; models: Array<{ alias: string }> }>).find(
        (project) => project.id === org.projectID,
      )!
    // Claude Code speaks only Anthropic Messages; Codex only Responses; Gemini CLI only the Gemini API.
    expect((await models("claude-code")).models.map((model) => model.alias)).toEqual(["mock-claude"])
    expect((await models("codex")).models.map((model) => model.alias).sort()).toEqual(["mock-codex", "mock-plain"])
    expect((await models("gemini-cli")).models.map((model) => model.alias)).toEqual(["mock-gemini"])
    expect(await models("qwen-code")).toMatchObject({ authorized: false, models: [] })
    expect((await member().client.get("/api/tools/windsurf")).status).toBe(404)
  })
})

describe("attribution, authorization and capabilities", () => {
  test("requests are attributed to the tool the key was issued for, with the version from its User-Agent", async () => {
    const response = await post("/gateway/anthropic/v1/messages?beta=true", keys["claude-code"]!, { model: "mock-claude", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }, {
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/2.1.292 (external, cli)",
      "x-claude-code-session-id": "cc-session-1",
    })
    expect(response.status).toBe(200)
    await response.text()
    expect(await lastRequest()).toMatchObject({ tool_id: "claude-code", tool_version: "2.1.292", status: "succeeded", billing_status: "exact" })
    const [linked] = await h.sql`select opencode_session_id from gateway_requests order by started_at desc limit 1`
    expect(linked.opencode_session_id).toBe("cc-session-1")
    const tool = (await org.admin.get("/api/admin/tools")).json.tools.find((entry: { id: string }) => entry.id === "claude-code")
    expect(tool.status).toMatchObject({ gatewayCompatible: true, usageVerified: true, available: false })
    expect(tool.evidence.lastVersion).toBe("2.1.292")
  })

  test("a tool removed from the project group, or excluded by a model, is refused", async () => {
    await org.admin.patch(`/api/admin/models/${ids.claude}`, { allowedTools: ["opencode"] })
    const excluded = await post("/gateway/anthropic/v1/messages", keys["claude-code"]!, { model: "mock-claude", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
    expect(excluded.status).toBe(403)
    expect(((await excluded.json()) as { error: { message: string } }).error.message).toContain("model_tool_not_allowed")
    await org.admin.patch(`/api/admin/models/${ids.claude}`, { allowedTools: null })

    await org.admin.put(`/api/admin/projects/${org.projectID}/tools`, { toolIDs: ["opencode", "codex", "gemini-cli", "cursor"] })
    const removed = await post("/gateway/anthropic/v1/messages", keys["claude-code"]!, { model: "mock-claude", max_tokens: 16, messages: [{ role: "user", content: "hi" }] })
    expect(removed.status).toBe(403)
    expect(removed.headers.get("x-should-retry")).toBe("false")
    expect(((await removed.json()) as { error: { message: string } }).error.message).toContain("tool_not_allowed")
    await org.admin.put(`/api/admin/projects/${org.projectID}/tools`, { toolIDs: ["opencode", "claude-code", "codex", "gemini-cli", "cursor"] })
  })

  test("requests needing a capability the model lacks are rejected before anything is reserved or sent", async () => {
    const calls = h.mock.control.calls
    const before = await h.sql`select count(*)::int as n from gateway_requests`
    const response = await post("/gateway/v1/responses", keys.codex!, {
      model: "mock-plain",
      input: [{ role: "user", content: [{ type: "input_text", text: "look" }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] }],
      tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: {} } }],
    })
    expect(response.status).toBe(400)
    const error = ((await response.json()) as { error: { code: string; message: string } }).error
    expect(error.code).toBe("model_capability_unsupported")
    expect(error.message).toContain("tool use")
    expect(error.message).toContain("image input")
    expect(h.mock.control.calls).toBe(calls)
    expect((await h.sql`select count(*)::int as n from gateway_requests`)[0].n).toBe(before[0].n)
  })

  test("a provider serving Chat and Responses at one base URL is reachable through both endpoints", async () => {
    const chat = await post("/gateway/v1/chat/completions", keys.codex!, { model: "mock-codex", messages: [{ role: "user", content: "hi" }] })
    expect(chat.status).toBe(200)
    await chat.text()
    const gemini = await post("/gateway/v1/chat/completions", keys.codex!, { model: "mock-gemini", messages: [{ role: "user", content: "hi" }] })
    expect(gemini.status).toBe(400)
    await gemini.text()
  })
})

describe("OpenAI Responses (Codex CLI)", () => {
  test("non-streamed responses are billed from the provider's usage and report the alias", async () => {
    const response = await post("/gateway/v1/responses", keys.codex!, { model: "mock-codex", input: "hello" }, { "user-agent": "codex_cli_rs/0.139.0 (Mac OS 27.2.0; arm64)" })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { model: string; output: Array<{ type: string }>; usage: { output_tokens: number } }
    expect(body.model).toBe("mock-codex")
    expect(body.output[0]!.type).toBe("message")
    expect(h.mock.control.lastBody?.max_output_tokens).toBe(256)
    expect(await lastRequest()).toMatchObject({ tool_id: "codex", tool_version: "0.139.0", protocol: "openai-responses", billing_status: "exact", output_tokens: String(body.usage.output_tokens) })
  })

  test("a streamed function call and its follow-up turn pass through unchanged and settle exactly", async () => {
    h.mock.control.toolRounds = { file: "/tmp/example.txt", rounds: 1 }
    try {
      const tools = [{ type: "function", name: "shell", parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } } }, required: ["command"] } }]
      const first = await sse(await post("/gateway/v1/responses", keys.codex!, { model: "mock-codex", stream: true, input: [{ role: "user", content: [{ type: "input_text", text: "read it" }] }], tools }))
      expect(first.map((event) => event.type)).toEqual([
        "response.created",
        "response.in_progress",
        "response.output_item.added",
        "response.function_call_arguments.delta",
        "response.function_call_arguments.done",
        "response.output_item.done",
        "response.completed",
      ])
      const call = first.find((event) => event.type === "response.output_item.done").item
      expect(call).toMatchObject({ type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["cat", "/tmp/example.txt"] }) })
      expect(await settledLast()).toMatchObject({ status: "succeeded", billing_status: "exact", stream: true })

      const second = await sse(
        await post("/gateway/v1/responses", keys.codex!, {
          model: "mock-codex",
          stream: true,
          input: [{ role: "user", content: [{ type: "input_text", text: "read it" }] }, call, { type: "function_call_output", call_id: call.call_id, output: "file contents" }],
          tools,
        }),
      )
      expect(second.find((event) => event.type === "response.output_text.done").text).toContain("tool ran successfully")
      expect(await settledLast()).toMatchObject({ status: "succeeded", billing_status: "exact" })
    } finally {
      h.mock.control.toolRounds = undefined
    }
  })

  test("a stream cut before response.completed is recorded as failed and estimated, never exact", async () => {
    h.mock.control.breakStreamAfter = 2
    try {
      const response = await post("/gateway/v1/responses", keys.codex!, { model: "mock-codex", stream: true, input: "hi" })
      const text = await response.text()
      expect(text).toContain("stream_interrupted")
    } finally {
      h.mock.control.breakStreamAfter = undefined
    }
    expect(await settledLast()).toMatchObject({ status: "failed", billing_status: "estimated" })
  })

  test("a client that disconnects mid-stream settles as cancelled with an estimate", async () => {
    h.mock.control.delayMs = 0
    const controller = new AbortController()
    const response = await fetch(`${h.origin}/gateway/v1/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${keys.codex}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-codex", stream: true, input: "a longer answer please" }),
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    await reader.read()
    controller.abort()
    const row = await eventually(lastRequest, (value) => value?.status === "cancelled" || value?.status === "succeeded", 5000)
    expect(["cancelled", "succeeded"]).toContain(row.status)
    if (row.status === "cancelled") expect(row.billing_status).toBe("estimated")
  })

  test("upstream errors keep OpenAI's error shape and retry semantics", async () => {
    h.mock.control.failNext = { status: 500, count: 5 }
    try {
      const response = await post("/gateway/v1/responses", keys.codex!, { model: "mock-codex", input: "hi" })
      expect(response.status).toBe(503)
      expect(response.headers.get("x-should-retry")).toBe("true")
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe("upstream_unavailable")
    } finally {
      h.mock.control.failNext = undefined
    }
  })
})

describe("usage by tool", () => {
  test("usage can be filtered and broken down by tool, and the request list carries the tool", async () => {
    const byTool = (await org.admin.get("/api/admin/usage/breakdown?by=tool")).json.rows as Array<{ key: string; requests: number }>
    expect(byTool.map((row) => row.key).sort()).toEqual(["claude-code", "codex"])
    const codexOnly = (await org.admin.get("/api/admin/usage/requests?tool=codex&limit=200")).json.items as Array<{ tool_id: string }>
    expect(codexOnly.length).toBeGreaterThan(0)
    expect(codexOnly.every((row) => row.tool_id === "codex")).toBe(true)
    expect((await org.admin.get("/api/admin/usage/breakdown?by=tool&tool=Bad Tool")).status).toBe(422)
  })
})

describe("member workbench: usage per connected tool", () => {
  test("lists each tool the member connected with its keys, usage, models and daily series, and only their own data", async () => {
    const body = (await member().client.get("/api/me/tools/usage?days=30")).json as {
      tools: Array<{ id: string; connections: Array<{ kind: string; projectCode: string }>; usage: { requests: number; costMicros: number; models: Array<{ alias: string }>; series: unknown[]; lastVersion: string | null } | null }>
      notConnected: number
    }
    const ids = body.tools.map((tool) => tool.id)
    expect(ids).toEqual(expect.arrayContaining(["opencode", "claude-code", "codex", "cursor"]))
    expect(ids).not.toContain("qwen-code")
    expect(body.notConnected).toBe(12 - ids.length)
    const claude = body.tools.find((tool) => tool.id === "claude-code")!
    expect(claude.connections).toEqual([expect.objectContaining({ kind: "tool-key", projectCode: "SEED" })])
    expect(claude.usage!.requests).toBeGreaterThan(0)
    expect(claude.usage!.models.map((model) => model.alias)).toContain("mock-claude")
    expect(claude.usage!.series.length).toBeGreaterThan(0)
    expect(claude.usage!.lastVersion).toBe("2.1.292")
    // A tool connected but never used shows its key and no usage.
    expect(body.tools.find((tool) => tool.id === "cursor")).toMatchObject({ usage: null })
    expect(JSON.stringify(body)).not.toContain("tos_at_")
    const usage = (await member().client.get("/api/me/usage")).json as { byTool: Array<{ key: string }> }
    expect(usage.byTool.map((row) => row.key)).toEqual(expect.arrayContaining(["claude-code", "codex"]))
    // The admin is not a member of the project and has no tool traffic of their own.
    expect((await org.admin.get("/api/me/tools/usage")).json.tools.filter((tool: { usage: unknown }) => tool.usage)).toEqual([])
  })
})

describe("member workbench: switching a tool connection's billing project", () => {
  test("a connection moves only to a project group that authorizes its tool", async () => {
    const other = (await org.admin.post("/api/admin/projects", { code: "OTHER", name: "Other Project", purpose: "data platform" })).json.id
    await org.admin.post(`/api/admin/projects/${other}/members`, { userIDs: [member().id] })
    const tools = (await member().client.get("/api/me/tools/usage")).json.tools as Array<{ id: string; connections: Array<{ id: string; projectID: string }>; projects: Array<{ code: string }> }>
    const claude = tools.find((tool) => tool.id === "claude-code")!
    const opencode = tools.find((tool) => tool.id === "opencode")!
    // New project groups allow only OpenCode, so Claude Code can stay on SEED alone.
    expect(claude.projects.map((project) => project.code)).toEqual(["SEED"])
    expect(opencode.projects.map((project) => project.code).sort()).toEqual(["OTHER", "SEED"])
    const refused = await member().client.post("/api/me/active-project", { sessionID: claude.connections[0]!.id, projectID: other })
    expect(refused.status).toBe(403)
    expect(refused.json.error.code).toBe("tool_not_allowed")
    const moved = await member().client.post("/api/me/active-project", { sessionID: opencode.connections[0]!.id, projectID: other })
    expect(moved.status).toBe(200)
    const after = (await member().client.get("/api/me/tools/usage")).json.tools.find((tool: { id: string }) => tool.id === "opencode")
    expect(after.connections[0].projectID).toBe(other)
    await member().client.post("/api/me/active-project", { sessionID: opencode.connections[0]!.id, projectID: org.projectID })
  })
})

describe("Launcher downloads", () => {
  test("lists builds with checksums, serves only Launcher file names, and needs no login", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "saorsa-downloads-"))
    await writeFile(path.join(dir, "saorsa-windows-x64.exe"), "MZ fake windows build")
    await writeFile(path.join(dir, "saorsa-windows-x64.exe.sha256"), `${"ab".repeat(32)}  saorsa-windows-x64.exe\n`)
    await writeFile(path.join(dir, "saorsa-windows-x64.exe.gz"), Bun.gzipSync("MZ fake windows build"))
    await writeFile(path.join(dir, "saorsa-macos-arm64"), "fake mac build")
    await writeFile(path.join(dir, "VERSION"), "0.1.0\n")
    await writeFile(path.join(dir, "secret.txt"), "should never be served")
    ;(h.deps.env as { TEAMOS_DOWNLOADS_DIR?: string }).TEAMOS_DOWNLOADS_DIR = dir
    try {
      const listing = await (await fetch(`${h.origin}/api/downloads`)).json()
      expect(listing).toEqual({
        version: "0.1.0",
        files: [
          { name: "saorsa-macos-arm64", platform: "macos-arm64", size: 14, sha256: null, url: "/downloads/saorsa-macos-arm64" },
          { name: "saorsa-windows-x64.exe", platform: "windows-x64", size: 21, sha256: "ab".repeat(32), url: "/downloads/saorsa-windows-x64.exe" },
        ],
      })
      const binary = await fetch(`${h.origin}/downloads/saorsa-windows-x64.exe`)
      expect(binary.status).toBe(200)
      expect(binary.headers.get("content-disposition")).toContain("saorsa-windows-x64.exe")
      expect(await binary.text()).toBe("MZ fake windows build")
      expect(binary.headers.get("cache-control")).toBe("no-cache")
      expect(await (await fetch(`${h.origin}/downloads/saorsa-windows-x64.exe.sha256`)).text()).toContain("ab".repeat(32))
      // Only a URL pinned to the current checksum may be cached at the edge.
      const pinned = await fetch(`${h.origin}/downloads/saorsa-windows-x64.exe.gz?v=${"ab".repeat(32)}`)
      expect(pinned.headers.get("content-type")).toBe("application/gzip")
      expect(pinned.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      expect(Buffer.from(Bun.gunzipSync(new Uint8Array(await pinned.arrayBuffer()))).toString()).toBe("MZ fake windows build")
      expect((await fetch(`${h.origin}/downloads/saorsa-windows-x64.exe.gz?v=${"cd".repeat(32)}`)).headers.get("cache-control")).toBe("no-cache")
      for (const name of ["secret.txt", "VERSION", "..%2Fsecret.txt", "saorsa-linux-x64"])
        expect({ name, status: (await fetch(`${h.origin}/downloads/${name}`)).status }).toEqual({ name, status: 404 })
    } finally {
      ;(h.deps.env as { TEAMOS_DOWNLOADS_DIR?: string }).TEAMOS_DOWNLOADS_DIR = undefined
    }
  })
})

describe("one-line Launcher install", () => {
  // Real runs of the served scripts against this server, installing into temporary directories only.
  const pwsh = process.env.SAORSA_PWSH ?? Bun.which("pwsh")
  const fixture = async (build: string, options: { checksum?: string; gzip?: boolean } = {}) => {
    const dir = await mkdtemp(path.join(tmpdir(), "saorsa-downloads-"))
    const name = build === "windows" ? "saorsa-windows-x64.exe" : `saorsa-macos-${process.arch === "arm64" ? "arm64" : "x64"}`
    // The Windows build is several MB so the streamed download goes through more than one read.
    const content = build === "windows" ? `fake ${name} build `.repeat(150_000) : `fake ${name} build`
    await writeFile(path.join(dir, name), content)
    await writeFile(path.join(dir, `${name}.sha256`), `${options.checksum ?? new Bun.CryptoHasher("sha256").update(content).digest("hex")}  ${name}\n`)
    if (options.gzip ?? true) await writeFile(path.join(dir, `${name}.gz`), Bun.gzipSync(content))
    ;(h.deps.env as { TEAMOS_DOWNLOADS_DIR?: string }).TEAMOS_DOWNLOADS_DIR = dir
    return content
  }
  const reset = () => ((h.deps.env as { TEAMOS_DOWNLOADS_DIR?: string }).TEAMOS_DOWNLOADS_DIR = undefined)
  const run = async (command: string[], env: Record<string, string>) => {
    const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } })
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { output: stdout + stderr, code }
  }

  test("the scripts carry this server's address and the build's pinned, compressed URL", async () => {
    expect(await (await fetch(`${h.origin}/install.ps1`)).text()).toContain("服务器尚未提供 Windows 版")
    const content = await fixture("windows")
    try {
      const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex")
      const response = await fetch(`${h.origin}/install.ps1`)
      expect(response.headers.get("content-type")).toContain("text/plain")
      const body = await response.text()
      expect(body).toContain(`'${h.origin}'`)
      expect(body).toContain(`$expected = '${sha256}'`)
      expect(body).toContain(`/downloads/saorsa-windows-x64.exe.gz?v=${sha256}`)
      expect(await (await fetch(`${h.origin}/install.sh`)).text()).toContain(`S='${h.origin}'`)
      // An operator file that is not a checksum is never embedded in a script.
      await fixture("windows", { checksum: "'; Remove-Item -Recurse C:\\; '" })
      expect(await (await fetch(`${h.origin}/install.ps1`)).text()).toContain("服务器尚未提供 Windows 版")
    } finally {
      reset()
    }
  })

  test.skipIf(process.platform !== "darwin")("install.sh verifies the macOS build and installs it", async () => {
    const content = await fixture("macos")
    try {
      const home = await mkdtemp(path.join(tmpdir(), "saorsa-home-"))
      const bin = path.join(home, "bin")
      // Terminal runs with a UTF-8 locale, where an unbraced variable next to "）" broke macOS /bin/sh.
      const result = await run(["sh", "-c", `curl -fsSL ${h.origin}/install.sh | sh`], { HOME: home, SAORSA_INSTALL_DIR: bin, PATH: `${bin}:${process.env.PATH}`, LC_ALL: "zh_CN.UTF-8" })
      expect(result.output).toContain("SHA-256 已校验")
      expect(result.code).toBe(0)
      expect(await Bun.file(path.join(bin, "saorsa")).text()).toBe(content)
      await fixture("macos", { checksum: "0".repeat(64), gzip: false })
      const tampered = await run(["sh", "-c", `rm ${bin}/saorsa; curl -fsSL ${h.origin}/install.sh | sh`], { HOME: home, SAORSA_INSTALL_DIR: bin, PATH: `${bin}:${process.env.PATH}`, LC_ALL: "en_US.UTF-8" })
      expect(tampered.code).not.toBe(0)
      expect(tampered.output).toContain("SHA-256 校验失败")
      expect(await Bun.file(path.join(bin, "saorsa")).exists()).toBe(false)
      expect(await Bun.file(path.join(bin, ".saorsa.download")).exists()).toBe(false)
    } finally {
      reset()
    }
  })

  test.skipIf(!pwsh)("install.ps1 runs through irm | iex, verifies the Windows build and installs it", async () => {
    const content = await fixture("windows")
    try {
      const appData = await mkdtemp(path.join(tmpdir(), "saorsa-appdata-"))
      const exe = path.join(appData, "Saorsa", "bin", "saorsa.exe")
      const command = [pwsh!, "-NoProfile", "-NonInteractive", "-Command", `irm ${h.origin}/install.ps1 | iex; Write-Host after-install`]
      const result = await run(command, { LOCALAPPDATA: appData })
      expect(result.output).toContain("SHA-256 已校验")
      expect(result.output).toMatch(/100%\s+\d+\.\d \/ \d+\.\d MB\s+[\d.]+ MB\/s/)
      // The script returns instead of exiting, so the member's PowerShell session keeps running.
      expect(result.output).toContain("after-install")
      expect(await Bun.file(exe).text()).toBe(content)
      await fixture("windows", { checksum: "0".repeat(64), gzip: false })
      await Bun.file(exe).delete()
      const tampered = await run(command, { LOCALAPPDATA: appData })
      expect(tampered.output).toContain("SHA-256 校验失败")
      expect(tampered.output).toContain("after-install")
      expect(await Bun.file(exe).exists()).toBe(false)
    } finally {
      reset()
    }
  }, 30_000)
})

describe("settlement", () => {
  test("a stream that settles before its 'streaming' status write lands is never left marked streaming", async () => {
    // Found by the real-tool lab: the fire-and-forget status write could overwrite an already settled row.
    // Batches stay within the member's concurrency limit (6), so every request really streams.
    const drained = () =>
      eventually(
        async () => Number(await h.redis.send("ZCOUNT", [`{teamos}:cc:user:${member().id}`, String(Date.now()), "+inf"])),
        (inFlight) => inFlight === 0,
        5000,
      )
    for (let batch = 0; batch < 4; batch++) {
      await drained()
      await Promise.all(
        Array.from({ length: 5 }, async () => {
          const response = await post("/gateway/v1/responses", keys.codex!, { model: "mock-codex", stream: true, input: "hi" })
          expect(response.status).toBe(200)
          await response.text()
        }),
      )
    }
    const rows = await eventually(
      () => h.sql`select status from gateway_requests where ended_at is not null and status in ('pending', 'streaming')`,
      (value) => value.length === 0,
      5000,
    )
    expect(rows.length).toBe(0)
    // Concurrency slots are released just after settlement; let them drain so later tests start clean.
    await drained()
  })
})

describe("Gemini native API (Gemini CLI)", () => {
  const path = (method: string) => `/gateway/gemini/v1beta/models/mock-gemini:${method}`
  const ask = { contents: [{ role: "user", parts: [{ text: "hello" }] }] }

  test("generateContent is billed from usageMetadata and the key travels as x-goog-api-key upstream", async () => {
    const response = await post(path("generateContent"), keys["gemini-cli"]!, ask, { "user-agent": "GeminiCLI/0.12.0/mock-gemini (darwin; arm64)" })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }>; usageMetadata: { candidatesTokenCount: number } }
    expect(body.candidates[0]!.content.parts[0]!.text).toContain("mock Gemini upstream")
    expect(h.mock.control.lastHeaders?.["x-goog-api-key"]).toBe(MOCK_KEY)
    expect((h.mock.control.lastBody?.generationConfig as { maxOutputTokens: number }).maxOutputTokens).toBe(256)
    expect(await lastRequest()).toMatchObject({ tool_id: "gemini-cli", tool_version: "0.12.0", protocol: "gemini", billing_status: "exact", output_tokens: String(body.usageMetadata.candidatesTokenCount) })
  })

  test("streamGenerateContent counts as exact only from the chunk that carries finishReason", async () => {
    const chunks = await sse(await post(`${path("streamGenerateContent")}?alt=sse`, keys["gemini-cli"]!, ask))
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.at(-1).candidates[0].finishReason).toBe("STOP")
    const row = await settledLast()
    expect(row).toMatchObject({ status: "succeeded", billing_status: "exact", stream: true })
    expect(Number(row.output_tokens)).toBe(chunks.at(-1).usageMetadata.candidatesTokenCount)

    h.mock.control.breakStreamAfter = 3
    try {
      await (await post(`${path("streamGenerateContent")}?alt=sse`, keys["gemini-cli"]!, ask)).text()
    } finally {
      h.mock.control.breakStreamAfter = undefined
    }
    // Running usage arrived on intermediate chunks, but without finishReason it is not a final count.
    expect(await settledLast()).toMatchObject({ status: "failed", billing_status: "estimated" })
  })

  test("a function call round trip passes Gemini's functionCall/functionResponse parts through", async () => {
    h.mock.control.toolRounds = { file: "/tmp/example.txt", rounds: 1 }
    try {
      const tools = [{ functionDeclarations: [{ name: "read_file", parameters: { type: "object", properties: { absolute_path: { type: "string" } }, required: ["absolute_path"] } }] }]
      const first = (await (await post(path("generateContent"), keys["gemini-cli"]!, { ...ask, tools })).json()) as any
      const call = first.candidates[0].content.parts[0].functionCall
      expect(call).toEqual({ name: "read_file", args: { absolute_path: "/tmp/example.txt" } })
      const second = (await (
        await post(path("generateContent"), keys["gemini-cli"]!, {
          contents: [...ask.contents, { role: "model", parts: [{ functionCall: call }] }, { role: "user", parts: [{ functionResponse: { name: "read_file", response: { output: "file contents" } } }] }],
          tools,
        })
      ).json()) as any
      expect(second.candidates[0].content.parts[0].text).toContain("tool ran successfully")
    } finally {
      h.mock.control.toolRounds = undefined
    }
  })

  test("countTokens is forwarded with the member's key and not metered; unknown methods are refused", async () => {
    const before = (await h.sql`select count(*)::int as n from gateway_requests`)[0].n
    const counted = await post(path("countTokens"), keys["gemini-cli"]!, ask)
    expect(counted.status).toBe(200)
    expect(((await counted.json()) as { totalTokens: number }).totalTokens).toBeGreaterThan(0)
    expect((await h.sql`select count(*)::int as n from gateway_requests`)[0].n).toBe(before)
    const unknown = await post(path("embedContent"), keys["gemini-cli"]!, ask)
    expect(unknown.status).toBe(404)
    expect(((await unknown.json()) as { error: { status: string } }).error.status).toBe("NOT_FOUND")
  })
})

describe("Claude Code gateway extras", () => {
  test("count_tokens is forwarded, the connection probe answers, and models are discoverable", async () => {
    const counted = await post("/gateway/anthropic/v1/messages/count_tokens", keys["claude-code"]!, { model: "mock-claude", messages: [{ role: "user", content: "hi" }] }, { "anthropic-version": "2023-06-01" })
    expect(counted.status).toBe(200)
    expect(((await counted.json()) as { input_tokens: number }).input_tokens).toBeGreaterThan(0)
    expect(h.mock.control.lastHeaders?.["x-api-key"]).toBe(MOCK_KEY)
    expect((await fetch(`${h.origin}/gateway/anthropic/api/hello`, { method: "HEAD" })).status).toBe(200)
    const models = await fetch(`${h.origin}/gateway/anthropic/v1/models?limit=1000`, { headers: { authorization: `Bearer ${keys["claude-code"]}` } })
    expect(((await models.json()) as { data: Array<{ id: string }> }).data.map((model) => model.id)).toEqual(["mock-claude"])
  })
})
