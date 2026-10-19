import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { TOOLS, toolByID } from "../../catalog/tools.js"
import { GUIDES } from "../../catalog/guides.js"
import { configureGemini, geminiPlan, restore, setPath } from "../src/configure.js"
import { installPlan } from "../src/install.js"
import { chooseTarget, childEnvironment, fill } from "../src/launch.js"
import { redact } from "../src/log.js"
import { parse } from "../src/main.js"

let home = ""

beforeAll(async () => {
  home = await mkdtemp(path.join(tmpdir(), "saorsa-launcher-unit-"))
  process.env.SAORSA_HOME = path.join(home, "saorsa")
  process.env.SAORSA_GEMINI_SETTINGS = path.join(home, ".gemini", "settings.json")
})

afterAll(() => {
  delete process.env.SAORSA_HOME
  delete process.env.SAORSA_GEMINI_SETTINGS
})

describe("catalog", () => {
  test("has exactly the 12 supported tools and every launchable CLI has a reviewed recipe", () => {
    expect(TOOLS.length).toBe(12)
    for (const tool of TOOLS.filter((entry) => entry.delivery === "launch-env")) expect(tool.launch?.kind).toBe("process")
    // Recipes contain only the documented placeholders.
    for (const tool of TOOLS) {
      const recipe = tool.launch
      if (recipe?.kind !== "process") continue
      for (const value of [...recipe.args, ...Object.values(recipe.env)])
        expect(value.replace(/\{(origin|token|model|dir)\}/g, "")).not.toMatch(/[{][a-z-]+[}]/)
    }
  })
})

describe("connection guides", () => {
  test("every tool has a guide whose placeholders are only the documented ones", () => {
    expect(Object.keys(GUIDES).sort()).toEqual(TOOLS.map((tool) => tool.id).sort())
    for (const [id, guide] of Object.entries(GUIDES)) {
      expect(guide.methods.length).toBeGreaterThan(0)
      const text = JSON.stringify(guide).replace(/\{(origin|model|key|project)\}/g, "").replace(/\{env:SAORSA_API_KEY\}/g, "")
      // Leftover {word} placeholders would be shown to members unfilled (TOML/JSON braces contain quotes or spaces).
      expect({ id, leftovers: text.match(/\{[a-z-]+\}/g) ?? [] }).toEqual({ id, leftovers: [] })
    }
  })

  test("a method is marked lab-verified only for tools this repository actually ran", () => {
    for (const [id, guide] of Object.entries(GUIDES))
      if (guide.methods.some((method) => method.verified === "lab")) expect({ id, lab: Boolean(toolByID(id)?.lab) }).toEqual({ id, lab: true })
  })
})

describe("arguments", () => {
  test("flags, values and pass-through arguments after --", () => {
    expect(parse(["launch", "claude-code", "--dir", "/w", "--yes", "--", "-p", "hi"])).toEqual({
      positional: ["launch", "claude-code"],
      flags: { dir: "/w", yes: true },
      passthrough: ["-p", "hi"],
    })
  })
})

describe("launch environment", () => {
  const values = { origin: "https://saorsa.test", token: "tos_at_launch", model: "claude-x", dir: "/work" }

  test("the token exists only in the child environment, and personal keys are removed", () => {
    const recipe = toolByID("claude-code")!.launch as Extract<NonNullable<ReturnType<typeof toolByID>>["launch"], { kind: "process" }>
    const env = childEnvironment(recipe, { PATH: "/bin", ANTHROPIC_API_KEY: "sk-personal", HOME: "/home/m" }, values)
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/m",
      ANTHROPIC_BASE_URL: "https://saorsa.test/gateway/anthropic",
      ANTHROPIC_AUTH_TOKEN: "tos_at_launch",
      ANTHROPIC_MODEL: "claude-x",
    })
  })

  test("Codex gets its provider inline, so no config file is written", () => {
    const recipe = toolByID("codex")!.launch as Extract<NonNullable<ReturnType<typeof toolByID>>["launch"], { kind: "process" }>
    expect(recipe.args.map((arg) => fill(arg, values))).toEqual([
      "-c",
      'model_providers.saorsa={name="Saorsa",base_url="https://saorsa.test/gateway/v1",env_key="SAORSA_API_KEY",wire_api="responses"}',
      "-c",
      'model_provider="saorsa"',
      "-m",
      "claude-x",
    ])
  })

  test("project and model choice only offers what the member is entitled to", () => {
    const me = {
      user: { username: "m", displayName: "M" },
      deviceID: "d",
      projects: [
        { id: "p1", code: "A", name: "A", tools: [{ id: "codex", models: [{ alias: "gpt-x", name: "x", protocol: "openai-responses", extraProtocols: [] }] }] },
        { id: "p2", code: "B", name: "B", tools: [] },
      ],
    }
    expect(chooseTarget(me, "codex", {}).model).toBe("gpt-x")
    expect(() => chooseTarget(me, "codex", { project: "B" })).toThrow("未授权该工具")
    expect(() => chooseTarget(me, "codex", { model: "other" })).toThrow("不可用于该工具")
    expect(() => chooseTarget(me, "gemini-cli", {})).toThrow("没有授权该工具")
  })
})

describe("installers", () => {
  test("npm and VS Code tools use fixed official commands; IDEs only get their official download page", () => {
    const npmPlan = installPlan(toolByID("claude-code")!, "install")
    if (!npmPlan.manual) expect(npmPlan.command.slice(1)).toEqual(["install", "-g", "@anthropic-ai/claude-code@latest"])
    const cursor = installPlan(toolByID("cursor")!, "install")
    expect(cursor).toMatchObject({ manual: true, url: "https://cursor.com/downloads" })
    expect("command" in cursor).toBe(false)
    expect(installPlan(toolByID("cursor")!, "uninstall")).toMatchObject({ manual: true, url: undefined })
  })
})

describe("Gemini CLI configuration", () => {
  const file = () => path.join(home, ".gemini", "settings.json")

  test("sets one key, backs the file up, keeps other settings, and restores only that key", async () => {
    await Bun.write(file(), JSON.stringify({ theme: "dark", security: { auth: { selectedType: "oauth-personal" }, folderTrust: { enabled: true } } }))
    expect(await geminiPlan()).toMatchObject({ ok: true, previous: "oauth-personal", alreadySet: false })
    const result = await configureGemini()
    expect(result.changed).toBe(true)
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ theme: "dark", security: { auth: { selectedType: "gemini-api-key" }, folderTrust: { enabled: true } } })
    expect((await readdir(path.join(home, "saorsa", "backups", "gemini-cli"))).length).toBe(1)

    // The member changes something else meanwhile; restore keeps it.
    const edited = JSON.parse(await readFile(file(), "utf8"))
    await writeFile(file(), JSON.stringify({ ...edited, theme: "light" }))
    expect(await restore("gemini-cli")).toMatchObject({ restored: true })
    expect(JSON.parse(await readFile(file(), "utf8"))).toEqual({ theme: "light", security: { auth: { selectedType: "oauth-personal" }, folderTrust: { enabled: true } } })
    expect(await restore("gemini-cli")).toMatchObject({ restored: false })
  })

  test("never overwrites a value the member changed after configuring, and refuses invalid JSON", async () => {
    await writeFile(file(), "{}")
    await configureGemini()
    await writeFile(file(), JSON.stringify({ security: { auth: { selectedType: "vertex-ai" } } }))
    expect(await restore("gemini-cli")).toMatchObject({ restored: false })
    expect(JSON.parse(await readFile(file(), "utf8")).security.auth.selectedType).toBe("vertex-ai")
    await writeFile(file(), "{ not json")
    expect(await geminiPlan()).toMatchObject({ ok: false })
    await expect(configureGemini()).rejects.toThrow("不是有效的 JSON")
  })

  test("setPath removes a key when restoring an originally absent value", () => {
    expect(setPath({ security: { auth: { selectedType: "x" }, other: 1 } }, ["security", "auth", "selectedType"], undefined)).toEqual({ security: { other: 1 } })
    expect(setPath({ theme: "dark", security: { auth: { selectedType: "x" } } }, ["security", "auth", "selectedType"], undefined)).toEqual({ theme: "dark" })
  })
})

describe("logs", () => {
  test("tokens, provider keys and credential headers are redacted", () => {
    expect(redact("x-goog-api-key=AIzaSyA-1234567890abcdefghij")).toBe("x-goog-api-key: [redacted]")
    expect(redact("token tos_at_abcdefghijklmnop and sk-ABCDEFGHIJKLMNOPQRST, Authorization: Bearer xyz")).toBe(
      "token [redacted] and [redacted], Authorization: [redacted]",
    )
  })
})
