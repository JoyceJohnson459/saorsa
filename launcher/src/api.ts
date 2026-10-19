import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"
import { paths } from "./paths.js"
import { secretStore } from "./secret.js"

export const VERSION = "0.1.0"

export interface Config {
  server: string
  deviceID: string
  deviceLabel: string
  defaultProjectID?: string
}

export class LauncherError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

export async function loadConfig(): Promise<Config | undefined> {
  const text = await readFile(paths.config(), "utf8").catch(() => undefined)
  return text ? (JSON.parse(text) as Config) : undefined
}

export async function saveConfig(config: Config) {
  await mkdir(path.dirname(paths.config()), { recursive: true })
  await writeFile(paths.config(), JSON.stringify(config, null, 2), { mode: 0o600 })
}

/** A stable random id for this device; it identifies installs in the console and never encodes hardware data. */
export function newConfig(server: string, label?: string): Config {
  return { server: server.replace(/\/+$/, ""), deviceID: randomUUID(), deviceLabel: (label ?? hostname()).slice(0, 80) || "device" }
}

export const platform = () => ({ os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : process.platform, arch: process.arch })

export function client(config: Config, token?: string) {
  const call = async <T>(method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> => {
    const response = await fetch(`${config.server}${route}`, {
      method,
      headers: {
        "content-type": "application/json",
        "user-agent": `saorsa-launcher/${VERSION} (${platform().os}; ${platform().arch})`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    }).catch((cause: Error) => {
      throw new LauncherError(`无法连接 Saorsa 服务器 ${config.server}：${cause.message}`)
    })
    const text = await response.text()
    const data = (text ? JSON.parse(text) : {}) as T & { error?: { message?: string } }
    if (response.status >= 400) throw new LauncherError(data.error?.message ?? `HTTP ${response.status}`, response.status)
    return { status: response.status, data }
  }
  return {
    get: <T>(route: string) => call<T>("GET", route).then((result) => result.data),
    post: <T>(route: string, body: unknown = {}) => call<T>("POST", route, body),
  }
}

/** The signed-in Launcher: config plus the session token from the OS credential store. */
export async function session() {
  const config = await loadConfig()
  if (!config) throw new LauncherError("尚未登录，请先运行：saorsa login --server <Saorsa 地址>")
  const token = await secretStore().get(config.server)
  if (!token) throw new LauncherError("尚未登录或登录已清除，请运行：saorsa login")
  return { config, token, api: client(config, token) }
}

export interface Me {
  user: { username: string; displayName: string }
  deviceID: string
  projects: Array<{
    id: string
    code: string
    name: string
    tools: Array<{ id: string; models: Array<{ alias: string; name: string; protocol: string; extraProtocols: string[] }> }>
  }>
}
