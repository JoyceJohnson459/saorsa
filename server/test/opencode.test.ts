import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MOCK_KEY } from "../src/mock-upstream.js"
import { chat, seedOrg, startHarness, type Harness } from "./harness.js"

// Official OpenCode releases connect through `/.well-known/opencode`: they run the advertised login command
// (stdout = token) and fetch `remote_config` on every start. Nothing on the client is modified.

let h: Harness
let org: Awaited<ReturnType<typeof seedOrg>>
let token = ""
let wellknown: { auth: { command: string[]; env: string }; remote_config: { url: string; headers: Record<string, string> } }

const config = (bearer: string) =>
  fetch(`${h.origin}/api/opencode/config`, { headers: { authorization: `Bearer ${bearer}` } }).then(async (response) => ({
    status: response.status,
    text: await response.text(),
  }))

beforeAll(async () => {
  h = await startHarness()
  org = await seedOrg(h)
})

afterAll(async () => {
  await h.stop()
})

describe("well-known login", () => {
  test("the manifest advertises a shell login command and a token-templated remote config", async () => {
    wellknown = (await (await fetch(`${h.origin}/.well-known/opencode`)).json()) as typeof wellknown
    expect(wellknown.auth.command.slice(0, 2)).toEqual(["sh", "-c"])
    expect(wellknown.auth.command.at(-1)).toBe(h.origin)
    expect(wellknown.auth.env).toBe("NEXCODE_TOKEN")
    expect(wellknown.remote_config).toEqual({
      url: `${h.origin}/api/opencode/config`,
      headers: { authorization: "Bearer {env:NEXCODE_TOKEN}" },
    })
  })

  test("the advertised command runs under sh, waits for browser approval and prints only the token", async () => {
    // Stub the browser openers so the test never launches a real browser.
    const bin = await mkdtemp(path.join(tmpdir(), "saorsa-open-"))
    for (const name of ["open", "xdg-open"]) {
      await writeFile(path.join(bin, name), "#!/bin/sh\nexit 0\n")
      await chmod(path.join(bin, name), 0o755)
    }
    const child = Bun.spawn(wellknown.auth.command, { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    const decoder = new TextDecoder()
    const reader = child.stderr.getReader()
    let stderr = ""
    while (!/device\?code=/.test(stderr)) {
      const { value, done } = await reader.read()
      if (done) break
      stderr += decoder.decode(value)
    }
    const code = /code=([A-Z0-9-]+)/.exec(stderr)?.[1]
    expect(code).toBeDefined()
    expect(stderr).toContain("请在浏览器中完成 Saorsa 授权")
    const approve = await org.members[0]!.client.post("/api/device/approve", { userCode: code, projectID: org.projectID, acknowledgeNotice: true })
    expect(approve.status).toBe(200)
    token = await new Response(child.stdout).text()
    expect(await child.exited).toBe(0)
    expect(token).toMatch(/^tos_at_[\w-]{20,}$/)
  })

  test("Windows members get a PowerShell login at <origin>/windows with the same remote config", async () => {
    const windows = (await (await fetch(`${h.origin}/windows/.well-known/opencode`)).json()) as typeof wellknown
    expect(windows.auth.command.slice(0, 4)).toEqual(["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
    expect(windows.auth.command).not.toContain("sh")
    expect(windows.auth.env).toBe("NEXCODE_TOKEN")
    expect(windows.remote_config).toEqual(wellknown.remote_config)
    const script = Buffer.from(windows.auth.command[4]!, "base64").toString("utf16le")
    expect(script).toContain(`$S = '${h.origin}'`)
    expect(script).toContain("/cli/login/poll")
  })

  // Runs the decoded Windows script in PowerShell 7 (set SAORSA_PWSH or put pwsh on PATH); Windows
  // PowerShell 5.1 itself is only exercised on a real Windows machine.
  const pwsh = process.env.SAORSA_PWSH ?? Bun.which("pwsh")
  test.skipIf(!pwsh)("the Windows login script completes the device flow under PowerShell", async () => {
    const windows = (await (await fetch(`${h.origin}/windows/.well-known/opencode`)).json()) as typeof wellknown
    const bin = await mkdtemp(path.join(tmpdir(), "saorsa-open-"))
    for (const name of ["open", "xdg-open"]) {
      await writeFile(path.join(bin, name), "#!/bin/sh\nexit 0\n")
      await chmod(path.join(bin, name), 0o755)
    }
    const child = Bun.spawn([pwsh!, ...windows.auth.command.slice(1)], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } })
    const decoder = new TextDecoder()
    const reader = child.stderr.getReader()
    let stderr = ""
    while (!/device\?code=/.test(stderr)) {
      const { value, done } = await reader.read()
      if (done) break
      stderr += decoder.decode(value)
    }
    const code = /code=([A-Z0-9-]+)/.exec(stderr)?.[1]
    expect(code).toBeDefined()
    expect(stderr).toContain("请在浏览器中完成 Saorsa 授权")
    const approve = await org.members[0]!.client.post("/api/device/approve", { userCode: code, projectID: org.projectID, acknowledgeNotice: true })
    expect(approve.status).toBe(200)
    expect(await new Response(child.stdout).text()).toMatch(/^tos_at_[\w-]{20,}$/)
    expect(await child.exited).toBe(0)
  }, 30_000)

  test("polling is pending until approval, returns the token exactly once, then refuses", async () => {
    const start = (await (await fetch(`${h.origin}/cli/login`, { method: "POST" })).text()).split(" ")
    const [deviceCode, , userCode] = start
    const poll = () => fetch(`${h.origin}/cli/login/poll`, { method: "POST", body: deviceCode })
    expect((await poll()).status).toBe(202)
    await org.members[0]!.client.post("/api/device/approve", { userCode, projectID: org.projectID, acknowledgeNotice: true })
    const issued = await poll()
    expect(issued.status).toBe(200)
    expect(await issued.text()).toMatch(/^tos_at_/)
    expect((await poll()).status).toBe(410)
    expect((await fetch(`${h.origin}/cli/login/poll`, { method: "POST", body: "tos_dc_unknown" })).status).toBe(410)
  })
})

describe("remote config for official clients", () => {
  test("delivers the managed providers, models, prices, restriction and MCP with placeholders only", async () => {
    const response = await config(token)
    expect(response.status).toBe(200)
    expect(response.text).not.toContain(token)
    expect(response.text).not.toContain(MOCK_KEY)
    const body = JSON.parse(response.text)
    expect(body.provider.saorsa.npm).toBe("@ai-sdk/openai-compatible")
    expect(body.provider.saorsa.options).toEqual({ baseURL: `${h.origin}/gateway/v1`, apiKey: "{env:NEXCODE_TOKEN}" })
    expect(body.provider.saorsa.name).toContain("SEED")
    expect(body.provider.saorsa.models["mock-chat"]).toMatchObject({ tool_call: true, cost: { input: 1, output: 2 } })
    expect(body.model).toBe("saorsa/mock-chat")
    expect(body.enabled_providers).toEqual(["saorsa", "saorsa-anthropic"])
    expect(body.mcp.saorsa).toEqual({ type: "remote", url: `${h.origin}/mcp`, headers: { Authorization: "Bearer {env:NEXCODE_TOKEN}" }, oauth: false })
  })

  test("the stored token works at the gateway and older session headers still link usage", async () => {
    const response = await chat(h.origin, token, { model: "mock-chat", messages: [{ role: "user", content: "hi" }] }, { "x-session-affinity": "ses_from_v1" })
    expect(response.status).toBe(200)
    await response.text()
    const [row] = await h.sql`select user_id, project_id, opencode_session_id from gateway_requests order by started_at desc limit 1`
    expect(row).toEqual({ user_id: org.members[0]!.id, project_id: org.projectID, opencode_session_id: "ses_from_v1" })
  })

  test("admin-entered names cannot inject client-side substitutions", async () => {
    await org.admin.patch(`/api/admin/projects/${org.projectID}`, { name: "Seed {env:HOME} {file:~/.ssh/id_rsa}" })
    const response = await config(token)
    expect(response.text).not.toContain("{env:HOME}")
    expect(response.text).not.toContain("{file:")
    await org.admin.patch(`/api/admin/projects/${org.projectID}`, { name: "Seed Project" })
  })

  test("token sessions slide forward while used", async () => {
    await h.sql`update user_sessions set access_expires_at = now() + interval '1 day', expires_at = now() + interval '1 day'
      where kind = 'client' and refresh_token_hash is null and revoked_at is null`
    expect((await config(token)).status).toBe(200)
    const [row] = await h.sql`select extract(epoch from access_expires_at - now()) / 86400 as days from user_sessions
      where kind = 'client' and refresh_token_hash is null and revoked_at is null order by last_used_at desc nulls last limit 1`
    expect(Number(row.days)).toBeGreaterThan(29)
  })

  test("a revoked login keeps OpenCode starting and tells the member how to log in again", async () => {
    await h.sql`update user_sessions set revoked_at = now() where kind = 'client' and refresh_token_hash is null and revoked_at is null`
    const response = await config(token)
    expect(response.status).toBe(200)
    const body = JSON.parse(response.text)
    expect(body.model).toBe("saorsa/login-required")
    expect(JSON.stringify(body.provider.saorsa.models)).toContain(`opencode auth login ${h.origin}`)
    const call = await chat(h.origin, token, { model: "login-required", messages: [{ role: "user", content: "hi" }] })
    expect(call.status).toBe(401)
    expect(call.headers.get("x-should-retry")).toBe("false")
    expect(((await call.json()) as { error: { message: string } }).error.message).toContain(`opencode auth login ${h.origin}`)
  })
})

describe("client version floor", () => {
  test("outdated official clients are told to upgrade; current and development builds pass", async () => {
    const set = await org.admin.patch("/api/admin/settings", { minOpenCodeVersion: "1.19.0" })
    expect(set.json.settings?.minOpenCodeVersion ?? set.json).toBe("1.19.0")
    const member = org.members[0]!.token
    const call = (agent: string) =>
      chat(h.origin, member, { model: "mock-chat", messages: [{ role: "user", content: "hi" }] }, { "user-agent": agent })
    const old = await call("opencode/1.17.0 ai-sdk/provider-utils/3.0.0")
    expect(old.status).toBe(426)
    expect(old.headers.get("x-should-retry")).toBe("false")
    expect(((await old.json()) as { error: { message: string } }).error.message).toContain("opencode upgrade")
    for (const agent of ["opencode/1.19.3 ai-sdk/provider-utils/3.0.0", "opencode/local/local/cli", "curl/8.0"]) {
      const response = await call(agent)
      expect({ agent, status: response.status }).toEqual({ agent, status: 200 })
      await response.text()
    }
    const invalid = await org.admin.patch("/api/admin/settings", { minOpenCodeVersion: "latest" })
    expect(invalid.status).toBe(422)
    await org.admin.patch("/api/admin/settings", { minOpenCodeVersion: null })
  })
})
