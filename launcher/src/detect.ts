import { existsSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Detector, ToolProfile } from "../../catalog/tools.js"

export interface Detection {
  /** null when the Launcher cannot tell (e.g. a plugin managed inside an IDE). */
  installed: boolean | null
  version: string | null
  location?: string
  note?: string
}

/** Detects one tool with its catalog detector. Read-only: runs only `<command> --version`-style probes. */
export async function detect(tool: ToolProfile): Promise<Detection> {
  return detectWith(tool.detect)
}

async function detectWith(detector: Detector): Promise<Detection> {
  if (detector.kind === "command") {
    const location = Bun.which(detector.command)
    if (!location) return { installed: false, version: null }
    const output = await probe([location, ...detector.versionArgs])
    return { installed: true, version: semver(output), location }
  }
  if (detector.kind === "vscode-extension") {
    const code = vscodeCLI()
    if (!code) return { installed: false, version: null, note: "未找到 VS Code" }
    const line = (await probe([code, "--list-extensions", "--show-versions"]))
      .split("\n")
      .find((entry) => entry.toLowerCase().startsWith(`${detector.id.toLowerCase()}@`))
    return line ? { installed: true, version: line.split("@")[1]?.trim() ?? null, location: "VS Code" } : { installed: false, version: null }
  }
  if (detector.kind === "app") {
    for (const candidate of process.platform === "win32" ? detector.windows.map(expandWindows) : process.platform === "darwin" ? detector.macos : []) {
      if (await exists(candidate)) return { installed: true, version: await appVersion(candidate), location: candidate }
    }
    return { installed: false, version: null }
  }
  return detectJetBrainsPlugin(detector.id)
}

/** VS Code's command-line launcher, from PATH or the standard install locations. */
export function vscodeCLI() {
  const candidates =
    process.platform === "darwin"
      ? ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"]
      : process.platform === "win32"
        ? [expandWindows("%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\bin\\code.cmd"), expandWindows("%ProgramFiles%\\Microsoft VS Code\\bin\\code.cmd")]
        : []
  return Bun.which("code") ?? candidates.find((candidate) => existsSync(candidate))
}

/**
 * JetBrains plugins live in per-IDE config directories; AI Assistant's folder is `ml-llm`. A missing folder
 * does not prove absence (it can be bundled with the IDE), so that case is reported as unknown.
 */
async function detectJetBrainsPlugin(id: string): Promise<Detection> {
  const root =
    process.platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support", "JetBrains")
      : process.platform === "win32"
        ? path.join(process.env.APPDATA ?? "", "JetBrains")
        : path.join(homedir(), ".local", "share", "JetBrains")
  const ides = await readdir(root).catch(() => [] as string[])
  if (!ides.length) return { installed: false, version: null, note: "未找到 JetBrains IDE 配置目录" }
  for (const ide of ides) {
    if (await exists(path.join(root, ide, "plugins", "ml-llm"))) return { installed: true, version: null, location: `${ide} (${id})` }
  }
  return { installed: null, version: null, note: `已找到 JetBrains IDE（${ides.join("、")}），未找到 AI Assistant 插件目录；请在 IDE 的 Settings › Plugins 中确认` }
}

async function probe(command: string[]) {
  const child = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } })
  const timer = setTimeout(() => child.kill(), 15_000)
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  clearTimeout(timer)
  return `${stdout}\n${stderr}`
}

const semver = (text: string) => /\b(\d+\.\d+\.\d+(?:[-+][\w.]+)?)\b/.exec(text)?.[1] ?? null

async function appVersion(app: string) {
  if (process.platform !== "darwin") return null
  const plist = path.join(app, "Contents", "Info.plist")
  if (!(await exists(plist))) return null
  return semver(await probe(["/usr/bin/defaults", "read", plist, "CFBundleShortVersionString"]))
}

const exists = (file: string) =>
  stat(file)
    .then(() => true)
    .catch(() => false)

const expandWindows = (value: string) => value.replace(/%([A-Za-z_]+)%/g, (_match, name: string) => process.env[name] ?? `%${name}%`)
