import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { eventually } from "./harness.js"
import { startLab } from "./lab/setup.js"

/**
 * REAL-TOOL LAB (opt-in: SAORSA_LAB=1). Drives the vendors' own CLIs against the real Saorsa gateway backed by
 * the TEST mock upstream, in throwaway HOME/config directories. Each run asks the tool to read a file; the mock
 * answers with a tool call for the tool's own read (or shell) tool and then echoes the tool output, so a pass
 * proves request routing, the protocol, streaming, one real tool round trip, attribution and exact billing.
 * It proves nothing about real models or real providers.
 *
 * Binaries: SAORSA_LAB_BIN (a node_modules/.bin directory with codex, gemini, qwen, copilot, kilo and
 * cline) plus `claude` and `opencode` on PATH. Missing binaries skip their test.
 */
const enabled = process.env.SAORSA_LAB === "1"
const bin = process.env.SAORSA_LAB_BIN ?? ""

let lab: Awaited<ReturnType<typeof startLab>>
let home = ""

const which = (name: string) => Bun.which(name, { PATH: `${bin}:${process.env.PATH}` }) ?? undefined
const tools = {
  claude: which("claude"),
  opencode: which("opencode"),
  codex: which("codex"),
  gemini: which("gemini"),
  qwen: which("qwen"),
  copilot: which("copilot"),
  kilo: which("kilo"),
  cline: bin ? Bun.which("cline", { PATH: path.join(bin, "..", "cline", "bin") }) ?? undefined : undefined,
}

async function run(command: string[], env: Record<string, string>) {
  const child = Bun.spawn(command, {
    cwd: lab.workspace,
    env: { PATH: process.env.PATH!, HOME: home, TERM: "dumb", ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), 180_000)
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearTimeout(timer)
  return { code, output: stdout + stderr }
}

async function gatewayRows(toolID: string) {
  return (await lab.h.sql`select protocol, stream, status, billing_status, tool_version from gateway_requests where tool_id = ${toolID}
    order by started_at`) as Array<{ protocol: string; stream: boolean; status: string; billing_status: string; tool_version: string | null }>
}

/** A pass needs the file's content in the tool's answer and every request settled with the provider's exact usage. */
async function expectVerified(toolID: string, result: { code: number; output: string }, protocol: string) {
  expect({ code: result.code, tail: result.code === 0 ? "" : result.output.slice(-2000) }).toEqual({ code: 0, tail: "" })
  expect(result.output).toContain("the answer is 42")
  // Background requests (titles, summaries) still in flight when a CLI exits settle as cancelled + estimated,
  // which is the correct outcome; failures are not allowed and every completed request must be exact.
  const rows = await eventually(
    () => gatewayRows(toolID),
    (value) => value.every((row) => row.status !== "pending" && row.status !== "streaming"),
    15_000,
  )
  const completed = rows.filter((row) => row.status === "succeeded")
  expect({ failed: rows.filter((row) => !["succeeded", "cancelled"].includes(row.status)).map((row) => row.status) }).toEqual({ failed: [] })
  expect(completed.length).toBeGreaterThanOrEqual(2)
  expect(completed.every((row) => row.protocol === protocol && row.billing_status === "exact")).toBe(true)
  expect(rows.filter((row) => row.status === "cancelled").every((row) => row.billing_status === "estimated")).toBe(true)
  console.log(
    `[lab] ${toolID}: ${completed.length} completed + ${rows.length - completed.length} cancelled requests, protocol ${protocol}, streamed=${rows.some((row) => row.stream)}, version ${rows[0]?.tool_version ?? "not in User-Agent"}`,
  )
}

beforeAll(async () => {
  if (!enabled) return
  lab = await startLab()
  lab.h.mock.control.toolRounds = { file: lab.file, rounds: 1 }
  home = await mkdtemp(path.join(tmpdir(), "saorsa-lab-home-"))
})

afterAll(async () => {
  if (enabled) await lab.h.stop()
})

describe.skipIf(!enabled)("real tools against the Saorsa gateway (mock upstream)", () => {
  test.skipIf(!tools.claude)("Claude Code: Anthropic Messages, Read tool", async () => {
    const result = await run([tools.claude!, "-p", "Read notes.txt and tell me the answer", "--allowedTools", "Read"], {
      CLAUDE_CONFIG_DIR: path.join(home, "claude"),
      ANTHROPIC_BASE_URL: `${lab.h.origin}/gateway/anthropic`,
      ANTHROPIC_AUTH_TOKEN: lab.keys["claude-code"]!,
      ANTHROPIC_MODEL: "claude-mock",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    })
    await expectVerified("claude-code", result, "anthropic-messages")
  }, 200_000)

  test.skipIf(!tools.codex)("Codex CLI: OpenAI Responses, shell tool in the read-only sandbox", async () => {
    const codexHome = path.join(home, "codex")
    await mkdir(codexHome, { recursive: true })
    await writeFile(
      path.join(codexHome, "config.toml"),
      `model = "mock-codex"\nmodel_provider = "saorsa"\n\n[model_providers.saorsa]\nname = "Saorsa"\nbase_url = "${lab.h.origin}/gateway/v1"\nenv_key = "SAORSA_API_KEY"\nwire_api = "responses"\n`,
    )
    const result = await run([tools.codex!, "exec", "--skip-git-repo-check", "-s", "read-only", "Read notes.txt and tell me the answer"], {
      CODEX_HOME: codexHome,
      SAORSA_API_KEY: lab.keys.codex!,
    })
    await expectVerified("codex", result, "openai-responses")
  }, 200_000)

  test.skipIf(!tools.gemini)("Gemini CLI: Gemini native API, read_file tool", async () => {
    await mkdir(path.join(home, ".gemini"), { recursive: true })
    await writeFile(path.join(home, ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }))
    const result = await run([tools.gemini!, "-m", "mock-gemini", "-p", "Read notes.txt and tell me the answer"], {
      GEMINI_API_KEY: lab.keys["gemini-cli"]!,
      GOOGLE_GEMINI_BASE_URL: `${lab.h.origin}/gateway/gemini`,
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    })
    await expectVerified("gemini-cli", result, "gemini")
  }, 200_000)

  test.skipIf(!tools.qwen)("Qwen Code: OpenAI Chat Completions, read_file tool", async () => {
    await mkdir(path.join(home, ".qwen"), { recursive: true })
    await writeFile(path.join(home, ".qwen", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "openai" } } }))
    const result = await run([tools.qwen!, "-p", "Read notes.txt and tell me the answer"], {
      OPENAI_BASE_URL: `${lab.h.origin}/gateway/v1`,
      OPENAI_API_KEY: lab.keys["qwen-code"]!,
      OPENAI_MODEL: "mock-chat",
    })
    await expectVerified("qwen-code", result, "openai-chat")
  }, 200_000)

  test.skipIf(!tools.copilot)("GitHub Copilot CLI (BYOK, offline): OpenAI Chat Completions, view tool", async () => {
    const result = await run([tools.copilot!, "-p", "Read notes.txt and tell me the answer", "--allow-tool", "view", "--allow-tool", "shell(cat)"], {
      COPILOT_PROVIDER_BASE_URL: `${lab.h.origin}/gateway/v1`,
      COPILOT_PROVIDER_TYPE: "openai",
      COPILOT_PROVIDER_API_KEY: lab.keys["github-copilot"]!,
      COPILOT_MODEL: "mock-chat",
      COPILOT_OFFLINE: "true",
    })
    await expectVerified("github-copilot", result, "openai-chat")
  }, 200_000)

  test.skipIf(!tools.cline)("Cline CLI (official CLI, not the VS Code extension): OpenAI-compatible, read_files tool", async () => {
    const config = path.join(home, "cline")
    const auth = await run([tools.cline!, "auth", "-p", "openai", "-k", lab.keys.cline!, "-m", "mock-chat", "-b", `${lab.h.origin}/gateway/v1`, "--config", `${config}/config`, "--data-dir", `${config}/data`], {})
    expect(auth.code).toBe(0)
    const result = await run([tools.cline!, "--config", `${config}/config`, "--data-dir", `${config}/data`, "-c", lab.workspace, "Read notes.txt and tell me the answer"], {})
    await expectVerified("cline", result, "openai-chat")
  }, 200_000)

  test.skipIf(!tools.kilo)("Kilo CLI (official CLI, not the VS Code extension): OpenAI-compatible, Read tool", async () => {
    const xdg = path.join(home, "kilo")
    await mkdir(path.join(xdg, "config", "kilo"), { recursive: true })
    await writeFile(
      path.join(xdg, "config", "kilo", "kilo.jsonc"),
      JSON.stringify({
        provider: {
          saorsa: {
            npm: "@ai-sdk/openai-compatible",
            name: "Saorsa",
            options: { baseURL: `${lab.h.origin}/gateway/v1`, apiKey: "{env:SAORSA_API_KEY}" },
            models: { "mock-chat": { name: "Mock Chat (TEST)", tool_call: true } },
          },
        },
        model: "saorsa/mock-chat",
      }),
    )
    const result = await run([tools.kilo!, "run", "-m", "saorsa/mock-chat", "Read notes.txt and tell me the answer"], {
      XDG_CONFIG_HOME: path.join(xdg, "config"),
      XDG_DATA_HOME: path.join(xdg, "data"),
      XDG_STATE_HOME: path.join(xdg, "state"),
      XDG_CACHE_HOME: path.join(xdg, "cache"),
      SAORSA_API_KEY: lab.keys["kilo-code"]!,
    })
    await expectVerified("kilo-code", result, "openai-chat")
  }, 200_000)

  describe("through the Saorsa Launcher", () => {
    const launcher = path.join(import.meta.dir, "..", "..", "launcher", "src", "main.ts")
    const launcherEnv = () => ({
      PATH: `${bin}:${process.env.PATH}`,
      SAORSA_HOME: path.join(home, "launcher"),
      SAORSA_SECRET_FILE: path.join(home, "launcher", "credential"),
      SAORSA_NO_BROWSER: "1",
    })

    test("signs in through the browser device flow", async () => {
      const login = Bun.spawn(["bun", launcher, "login", "--server", lab.h.origin, "--label", "lab-mac"], {
        cwd: lab.workspace,
        env: { HOME: home, ...launcherEnv() },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      let text = ""
      const decoder = new TextDecoder()
      for await (const chunk of login.stdout) {
        text += decoder.decode(chunk)
        const code = /验证码 ([A-Z0-9-]+)/.exec(text)?.[1]
        if (code) {
          await lab.org.members[0]!.client.post("/api/device/approve", { userCode: code, projectID: lab.org.projectID, acknowledgeNotice: true })
          break
        }
      }
      expect(await login.exited).toBe(0)
    }, 120_000)

    // Each case: the Launcher's own catalog recipe starts the real CLI with a short-lived child token.
    // env is a function: the lab home directory only exists once beforeAll has run.
    const cases: Array<{ tool: string; binary: keyof typeof tools; model: string; args: string[]; env?: () => Record<string, string>; configure?: boolean }> = [
      { tool: "claude-code", binary: "claude", model: "claude-mock", args: ["-p", "Read notes.txt and tell me the answer", "--allowedTools", "Read"], env: () => ({ CLAUDE_CONFIG_DIR: path.join(home, "claude-launcher"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }) },
      { tool: "codex", binary: "codex", model: "mock-codex", args: ["exec", "--skip-git-repo-check", "-s", "read-only", "Read notes.txt and tell me the answer"], env: () => ({ CODEX_HOME: path.join(home, "codex-launcher") }) },
      { tool: "gemini-cli", binary: "gemini", model: "mock-gemini", args: ["-p", "Read notes.txt and tell me the answer"], env: () => ({ GEMINI_CLI_TRUST_WORKSPACE: "true" }), configure: true },
      { tool: "qwen-code", binary: "qwen", model: "mock-chat", args: ["-p", "Read notes.txt and tell me the answer"] },
      { tool: "github-copilot", binary: "copilot", model: "mock-chat", args: ["-p", "Read notes.txt and tell me the answer", "--allow-tool", "view", "--allow-tool", "shell(cat)"] },
    ]
    for (const entry of cases)
      test.skipIf(!tools[entry.binary])(`launches the real ${entry.tool}`, async () => {
        const env: Record<string, string> = { ...launcherEnv(), ...entry.env?.() }
        if (env.CODEX_HOME) await mkdir(env.CODEX_HOME, { recursive: true })
        if (entry.configure) {
          // Start from the member's own (here: empty) Gemini settings so configure and restore are both exercised.
          await rm(path.join(home, ".gemini", "settings.json"), { force: true })
          expect((await run(["bun", launcher, "configure", entry.tool, "--yes"], env)).code).toBe(0)
        }
        const before = (await gatewayRows(entry.tool)).length
        const result = await run(["bun", launcher, "launch", entry.tool, "--yes", "--dir", lab.workspace, "--model", entry.model, "--", ...entry.args], env)
        expect({ code: result.code, tail: result.code === 0 ? "" : result.output.slice(-1500) }).toEqual({ code: 0, tail: "" })
        expect(result.output).toContain("the answer is 42")
        const rows = await eventually(
          () => lab.h.sql`select r.status, r.billing_status, s.parent_session_id is not null as child from gateway_requests r
            join user_sessions s on s.id = r.client_session_id where r.tool_id = ${entry.tool} order by r.started_at`,
          (value) => value.every((row: { status: string }) => row.status !== "pending" && row.status !== "streaming"),
          15_000,
        )
        const launched = rows.slice(before).filter((row: { status: string }) => row.status === "succeeded")
        expect(launched.length).toBeGreaterThanOrEqual(2)
        expect(launched.every((row: { billing_status: string; child: boolean }) => row.billing_status === "exact" && row.child)).toBe(true)
        if (entry.configure) expect((await run(["bun", launcher, "restore", entry.tool], env)).output).toContain("已恢复")
        console.log(`[lab] launcher → ${entry.tool}: ${launched.length} requests on a Launcher child token`)
      }, 300_000)
  })

  test.skipIf(!tools.opencode)("OpenCode: official `opencode auth login` well-known flow, then a Read tool round trip", async () => {
    const xdg = path.join(home, "opencode")
    const stubs = path.join(xdg, "bin")
    await mkdir(stubs, { recursive: true })
    for (const name of ["open", "xdg-open"]) {
      await writeFile(path.join(stubs, name), "#!/bin/sh\nexit 0\n")
      await chmod(path.join(stubs, name), 0o755)
    }
    const env = {
      PATH: `${stubs}:${process.env.PATH}`,
      HOME: home,
      XDG_CONFIG_HOME: path.join(xdg, "config"),
      XDG_DATA_HOME: path.join(xdg, "data"),
      XDG_STATE_HOME: path.join(xdg, "state"),
      XDG_CACHE_HOME: path.join(xdg, "cache"),
    }
    const login = Bun.spawn([tools.opencode!, "auth", "login", lab.h.origin], { cwd: lab.workspace, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const decoder = new TextDecoder()
    let text = ""
    for (const stream of [login.stderr.getReader(), login.stdout.getReader()]) void (async () => {
      for (;;) {
        const chunk = await stream.read()
        if (chunk.done) return
        text += decoder.decode(chunk.value)
      }
    })()
    const code = await (async () => {
      for (let i = 0; i < 60; i++) {
        const match = /code=([A-Z0-9-]+)/.exec(text)
        if (match) return match[1]
        await Bun.sleep(500)
      }
    })()
    const approve = await lab.org.members[0]!.client.post("/api/device/approve", { userCode: code, projectID: lab.org.projectID, acknowledgeNotice: true })
    const exit = await login.exited
    expect({ code: Boolean(code), approve: approve.status, exit }).toEqual({ code: true, approve: 200, exit: 0 })
    const models = await run([tools.opencode!, "models"], env)
    expect(models.output).toContain("saorsa/mock-chat")
    expect(models.output).not.toContain("opencode/")
    const result = await run([tools.opencode!, "run", "-m", "saorsa/mock-chat", "Read notes.txt and tell me the answer"], env)
    await expectVerified("opencode", result, "openai-chat")
  }, 300_000)
})
