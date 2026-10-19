import type { ToolProfile } from "../../catalog/tools.js"
import { vscodeCLI } from "./detect.js"

export type InstallAction = "install" | "update" | "uninstall"

/**
 * What an install/update/uninstall will do, from the tool's fixed catalog entry: an npm package from the public
 * registry, a VS Code Marketplace extension, or (for IDEs and JetBrains plugins) the vendor's official download
 * page, which the Launcher only opens. There is no path from the server to a command line.
 */
export function installPlan(tool: ToolProfile, action: InstallAction) {
  const installer = tool.install
  if (installer.kind === "npm") {
    const npm = Bun.which("npm")
    if (!npm) return { manual: true as const, reason: "未找到 npm（需要 Node.js 18+）。请先从 https://nodejs.org 安装 Node.js。" }
    const command = action === "uninstall" ? [npm, "uninstall", "-g", installer.package] : [npm, "install", "-g", `${installer.package}@latest`]
    return {
      manual: false as const,
      command,
      source: `npm 官方仓库 registry.npmjs.org 的 ${installer.package}`,
      verification: "npm 安装时按仓库记录的 sha512 完整性校验下载的包；安装前会显示版本与 integrity 值",
      package: installer.package,
    }
  }
  if (installer.kind === "vscode-extension") {
    const code = vscodeCLI()
    if (!code) return { manual: true as const, reason: "未找到 VS Code，请先安装 VS Code：https://code.visualstudio.com" }
    return {
      manual: false as const,
      command: [code, action === "uninstall" ? "--uninstall-extension" : "--install-extension", installer.id, ...(action === "update" ? ["--force"] : [])],
      source: `VS Code Marketplace 的 ${installer.id}`,
      verification: "由 VS Code 从 Marketplace 下载并校验扩展签名",
      package: undefined,
    }
  }
  return {
    manual: true as const,
    reason:
      action === "uninstall"
        ? `${tool.name} 需要按其官方方式卸载，Saorsa Launcher 不会删除它。`
        : `${tool.name} 不支持由 Launcher 安全地自动安装。请从官方地址下载安装：${installer.url}`,
    url: action === "uninstall" ? undefined : installer.url,
  }
}

/** Registry metadata shown before an npm install; npm itself enforces the integrity on download. */
export async function npmMetadata(pkg: string) {
  const npm = Bun.which("npm")
  if (!npm) return undefined
  const child = Bun.spawn([npm, "view", `${pkg}@latest`, "version", "dist.integrity", "--json"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
  const text = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) return undefined
  const data = JSON.parse(text) as { version?: string; "dist.integrity"?: string }
  return { version: data.version, integrity: data["dist.integrity"] }
}

/** Runs a planned command with the member's terminal attached; returns its exit code. */
export async function runVisible(command: string[], cwd?: string) {
  const child = Bun.spawn(command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", cwd })
  return child.exited
}

/** Opens a URL in the default browser (SAORSA_NO_BROWSER=1 prints it only: headless machines, tests). */
export async function openURL(url: string) {
  if (process.env.SAORSA_NO_BROWSER === "1") return
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url]
  await Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited
}
