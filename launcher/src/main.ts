#!/usr/bin/env bun
import { TOOLS, toolByID, type ToolProfile } from "../../catalog/tools.js"
import { GUIDES, type GuideStep } from "../../catalog/guides.js"
import { client, LauncherError, loadConfig, newConfig, platform, saveConfig, session, VERSION, type Me } from "./api.js"
import { configureGemini, geminiPlan, isConfigured, restore } from "./configure.js"
import { detect } from "./detect.js"
import { installPlan, npmMetadata, openURL, runVisible, type InstallAction } from "./install.js"
import { chooseTarget, childEnvironment, fill, ideCommand } from "./launch.js"
import { log } from "./log.js"
import { consent } from "./prompt.js"
import { secretStore } from "./secret.js"

/**
 * Saorsa Launcher: signs the member in, detects / installs / configures / launches the 12 supported tools from
 * their official sources, and reports what it did. It never runs commands received from a server, never uploads
 * project files, and never writes tokens to logs or to tool config files.
 */
const HELP = `Saorsa Launcher ${VERSION} — AI Development Under Control

用法：
  saorsa login --server <URL> [--label <设备名>]   登录（浏览器中确认）
  saorsa logout                                    退出并删除本机凭据
  saorsa status                                    账户、项目组与授权工具
  saorsa tools                                     检测 12 款工具的安装状态并上报
  saorsa install|update|uninstall <工具> [--yes]   从官方来源安装 / 更新 / 卸载
  saorsa configure <工具> [--yes] [--key --project <项目组>]
                                                   一次性配置；--key 为 IDE 类工具签发 Saorsa Key
  saorsa restore <工具>                            撤销 Launcher 对该工具配置的修改
  saorsa launch <工具> [--dir <目录>] [--project <项目组>] [--model <模型>] [--yes] [-- 工具参数]
  saorsa doctor                                    诊断连接、登录、凭据存储与工具
  saorsa guide <工具> [--model <模型>]             显示该工具的详细连接方式
工具：${TOOLS.map((tool) => tool.id).join(", ")}`

type Flags = { positional: string[]; flags: Record<string, string | true>; passthrough: string[] }

function parse(argv: string[]): Flags {
  const split = argv.indexOf("--")
  const own = split === -1 ? argv : argv.slice(0, split)
  const result: Flags = { positional: [], flags: {}, passthrough: split === -1 ? [] : argv.slice(split + 1) }
  for (let index = 0; index < own.length; index++) {
    const arg = own[index]!
    if (!arg.startsWith("--")) {
      result.positional.push(arg)
      continue
    }
    const name = arg.slice(2)
    const next = own[index + 1]
    if (["yes", "key", "help", "version"].includes(name) || next === undefined || next.startsWith("--")) result.flags[name] = true
    else {
      result.flags[name] = next
      index++
    }
  }
  return result
}

const text = (flags: Flags, name: string) => (typeof flags.flags[name] === "string" ? (flags.flags[name] as string) : undefined)

function requireTool(id: string | undefined): ToolProfile {
  const tool = id ? toolByID(id) : undefined
  if (!tool) throw new LauncherError(`请指定工具：${TOOLS.map((entry) => entry.id).join(", ")}`)
  return tool
}

async function login(flags: Flags) {
  const previous = await loadConfig()
  const server = text(flags, "server") ?? previous?.server
  if (!server) throw new LauncherError("请指定服务器：saorsa login --server https://saorsa.example.com")
  const config = previous && previous.server === server.replace(/\/+$/, "") ? { ...previous, deviceLabel: text(flags, "label") ?? previous.deviceLabel } : newConfig(server, text(flags, "label"))
  const api = client(config)
  const device = { deviceID: config.deviceID, deviceLabel: config.deviceLabel, ...platform() }
  const start = (await api.post<{ deviceCode: string; userCode: string; verificationURL: string; interval: number }>("/api/launcher/login", device)).data
  console.log(`请在浏览器中确认登录（验证码 ${start.userCode}）：\n  ${start.verificationURL}`)
  await openURL(start.verificationURL).catch(() => {})
  for (;;) {
    await Bun.sleep(start.interval * 1000)
    const poll = await api.post<{ token?: string; defaultProjectID?: string }>("/api/launcher/login/poll", { deviceCode: start.deviceCode, ...device })
    if (poll.status === 202) continue
    const store = secretStore()
    await store.set(config.server, poll.data.token!)
    await saveConfig({ ...config, defaultProjectID: poll.data.defaultProjectID })
    await log("login", { server: config.server, store: store.kind })
    console.log(`已登录 ${config.server}（凭据保存在 ${store.kind}）。`)
    return
  }
}

async function logout() {
  const config = await loadConfig()
  if (!config) return console.log("当前未登录。")
  const store = secretStore()
  const token = await store.get(config.server)
  if (token) await client(config, token).post("/api/launcher/logout").catch(() => {})
  await store.delete(config.server)
  await log("logout", { server: config.server })
  console.log("已退出；本机凭据已删除。由本 Launcher 启动的工具会话同时失效。")
}

async function status() {
  const { config, api } = await session()
  const me = await api.get<Me>("/api/launcher/me")
  console.log(`${me.user.displayName}（${me.user.username}） @ ${config.server} · 设备 ${config.deviceLabel}`)
  for (const project of me.projects)
    console.log(`  ${project.code} ${project.name}：${project.tools.map((tool) => toolByID(tool.id)?.name ?? tool.id).join("、") || "未授权工具"}`)
}

async function detectAll() {
  return Promise.all(TOOLS.map(async (tool) => ({ tool, found: await detect(tool).catch((cause: Error) => ({ installed: null, version: null, note: cause.message })) })))
}

/** Reports detection results to the console (installed / version / configured); no paths or file contents. */
async function report(results: Awaited<ReturnType<typeof detectAll>>) {
  const { config, api } = await session()
  await api.post("/api/launcher/report", {
    deviceLabel: config.deviceLabel,
    ...platform(),
    launcherVersion: VERSION,
    installations: await Promise.all(
      results.map(async ({ tool, found }) => ({
        toolID: tool.id,
        installed: found.installed === true,
        version: found.version,
        configured: await isConfigured(tool.id),
        error: found.installed === null ? (found.note ?? null) : null,
      })),
    ),
  })
}

async function tools() {
  const results = await detectAll()
  const me = await session()
    .then((current) => current.api.get<Me>("/api/launcher/me"))
    .catch(() => undefined)
  for (const { tool, found } of results) {
    const entitled = me?.projects.some((project) => project.tools.some((entry) => entry.id === tool.id))
    const state = found.installed === true ? `已安装 ${found.version ?? ""}`.trim() : found.installed === false ? "未安装" : "无法确定"
    console.log(`${tool.id.padEnd(15)} ${state.padEnd(18)} ${me ? (entitled ? "已授权" : "未授权") : ""}${found.note ? `  (${found.note})` : ""}`)
  }
  if (me) await report(results)
}

async function install(action: InstallAction, flags: Flags) {
  const tool = requireTool(flags.positional[1])
  const plan = installPlan(tool, action)
  if (plan.manual) {
    console.log(plan.reason)
    if (plan.url && (await consent([`打开官方下载页：${plan.url}`], { yes: flags.flags.yes === true }))) await openURL(plan.url)
    return
  }
  const metadata = plan.package && action !== "uninstall" ? await npmMetadata(plan.package) : undefined
  const approved = await consent(
    [
      `${{ install: "安装", update: "更新", uninstall: "卸载" }[action]} ${tool.name}`,
      `来源：${plan.source}${metadata?.version ? `（最新版本 ${metadata.version}）` : ""}`,
      ...(metadata?.integrity ? [`完整性：${metadata.integrity}`] : []),
      `校验：${plan.verification}`,
      `命令：${plan.command.join(" ")}`,
    ],
    { yes: flags.flags.yes === true },
  )
  if (!approved) return event(tool.id, action, "cancelled", null, null)
  const code = await runVisible(plan.command)
  const found = await detect(tool)
  const ok = code === 0 && (action === "uninstall" ? found.installed === false : found.installed === true)
  console.log(ok ? `完成：${tool.name} ${action === "uninstall" ? "已卸载" : `版本 ${found.version ?? "未知"}`}` : `未成功（退出码 ${code}）。请查看上方输出。`)
  await event(tool.id, action, ok ? "succeeded" : "failed", found.version, ok ? null : `exit ${code}`)
  await report(await detectAll()).catch(() => {})
}

async function configure(flags: Flags) {
  const tool = requireTool(flags.positional[1])
  const yes = flags.flags.yes === true
  if (flags.flags.key) return issueKey(tool, flags)
  const recipe = tool.launch
  if (recipe?.kind === "process" && recipe.configure === "gemini-auth") {
    const plan = await geminiPlan()
    if (!plan.ok) throw new LauncherError(plan.error)
    if (plan.alreadySet) return console.log(`${plan.file} 已选择 API Key 认证，无需修改。`)
    const approved = await consent(
      [
        `修改 ${plan.file}：security.auth.selectedType = "gemini-api-key"（当前：${JSON.stringify(plan.previous ?? null)}）`,
        "修改前会备份原文件；可用 saorsa restore gemini-cli 只撤销这一项。",
        "注意：不经 Launcher 启动 Gemini CLI 时也会使用 API Key 认证。",
      ],
      { yes },
    )
    if (!approved) return event(tool.id, "configure", "cancelled", null, null)
    const result = await configureGemini()
    console.log(`已配置${result.backup ? `，原文件备份于 ${result.backup}` : ""}。`)
    return event(tool.id, "configure", "succeeded", null, null)
  }
  if (recipe?.kind === "process" && recipe.configure === "opencode-login") {
    const { config } = await session()
    // OpenCode runs the login command without a shell; Windows has no `sh`, so it logs in at <server>/windows.
    const command = ["opencode", "auth", "login", process.platform === "win32" ? `${config.server}/windows` : config.server]
    if (!(await consent([`运行 OpenCode 官方登录：${command.join(" ")}`, "OpenCode 会在浏览器中请你确认并选择计费项目组。"], { yes }))) return
    const code = await runVisible(command)
    return event(tool.id, "configure", code === 0 ? "succeeded" : "failed", null, code === 0 ? null : `exit ${code}`)
  }
  if (recipe?.kind === "process") return console.log(`${tool.name} 无需额外配置：saorsa launch ${tool.id} 会在启动时注入 Saorsa 设置，不修改任何文件。`)
  await printManualSettings(tool)
}

async function printManualSettings(tool: ToolProfile) {
  const config = await loadConfig()
  console.log(`${tool.name} 需要在其自身的设置界面中配置（Launcher 不修改 IDE 的内部存储）：`)
  for (const route of tool.routes) {
    console.log(`  [${route.protocol}]`)
    for (const [name, value] of Object.entries(route.settings)) console.log(`    ${name}: ${value.replaceAll("{origin}", config?.server ?? "<Saorsa 地址>")}`)
  }
  console.log(`  {ide-key} 可用：saorsa configure ${tool.id} --key --project <项目组>（只显示一次）`)
}

async function issueKey(tool: ToolProfile, flags: Flags) {
  const { config, api } = await session()
  const me = await api.get<Me>("/api/launcher/me")
  const target = chooseTarget(me, tool.id, { project: text(flags, "project"), defaultProjectID: config.defaultProjectID })
  if (!(await consent([`为 ${tool.name} 签发一把长期 Saorsa Key（项目组 ${target.project.code}），只显示一次`], { yes: flags.flags.yes === true }))) return
  const result = (await api.post<{ key: string }>("/api/launcher/tool-key", { toolID: tool.id, projectID: target.project.id })).data
  console.log(`\n${result.key}\n\n请立即填写到 ${tool.name} 的设置中；可在 Saorsa 网页“个人设置 → 登录设备”中撤销。`)
}

async function launch(flags: Flags) {
  const tool = requireTool(flags.positional[1])
  const recipe = tool.launch
  if (!recipe) return printManualSettings(tool)
  const { config, api } = await session()
  const dir = text(flags, "dir") ?? process.cwd()
  const me = await api.get<Me>("/api/launcher/me")
  const target = chooseTarget(me, tool.id, { project: text(flags, "project"), model: text(flags, "model"), defaultProjectID: config.defaultProjectID })
  if (recipe.kind === "ide") {
    const command = await ideCommand(tool, recipe.editor, dir)
    if (!command) throw new LauncherError(`未找到 ${tool.name}，请先安装：saorsa install ${tool.id}`)
    if (!(await consent([`用 ${tool.name} 打开 ${dir}`, `模型与 Key 需在 ${tool.name} 设置中配置（saorsa configure ${tool.id}）`], { yes: flags.flags.yes === true }))) return
    await runVisible(command)
    return event(tool.id, "launch", "succeeded", null, null)
  }
  const found = await detect(tool)
  if (!found.installed) throw new LauncherError(`未找到 ${tool.name}，请先运行：saorsa install ${tool.id}`)
  if (recipe.configure === "gemini-auth" && !(await isConfigured(tool.id)))
    throw new LauncherError(`首次使用请先运行：saorsa configure ${tool.id}`)
  if (
    !(await consent(
      [`启动 ${tool.name} ${found.version ?? ""}`.trim(), `目录：${dir}`, `计费项目组：${target.project.code} · 模型：${target.model}`],
      { yes: flags.flags.yes === true },
    ))
  )
    return event(tool.id, "launch", "cancelled", found.version, null)
  const issued =
    recipe.configure === "opencode-login"
      ? { token: "", origin: config.server }
      : (await api.post<{ token: string; origin: string }>("/api/launcher/tool-token", { toolID: tool.id, projectID: target.project.id })).data
  const values = { origin: issued.origin, token: issued.token, model: target.model, dir }
  const child = Bun.spawn([found.location ?? recipe.command, ...recipe.args.map((arg) => fill(arg, values)), ...flags.passthrough], {
    cwd: dir,
    env: childEnvironment(recipe, process.env, values),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  await event(tool.id, "launch", "succeeded", found.version, null)
  process.exitCode = await child.exited
}

/** Prints a tool's connection guide with this server's address filled in (keys are never printed here). */
async function guide(flags: Flags) {
  const tool = requireTool(flags.positional[1])
  const config = await loadConfig()
  const content = GUIDES[tool.id]
  const windows = process.platform === "win32"
  const fill = (value: string) =>
    value
      .replaceAll("{origin}", config?.server ?? "<Saorsa 地址>")
      .replaceAll("{model}", text(flags, "model") ?? "<模型别名>")
      .replaceAll("{key}", "<你的 Saorsa Key>")
      .replaceAll("{project}", "<项目组>")
  const steps = (list: GuideStep[], indent = "  ") =>
    list.filter((step) => !step.os || step.os === (windows ? "windows" : "unix")).forEach((step, index) => {
      console.log(`${indent}${index + 1}. ${fill(step.title)}`)
      if (step.text) console.log(`${indent}   ${fill(step.text)}`)
      for (const command of step.commands ?? []) console.log(`${indent}   $ ${fill(command)}`)
      for (const [name, value] of Object.entries(step.env ?? {}))
        console.log(`${indent}   ${windows ? `$env:${name} = "${fill(value)}"` : `export ${name}="${fill(value)}"`}`)
      if (step.file) console.log(`${indent}   ${step.file.path}:\n${fill(step.file.content).replace(/^/gm, `${indent}     `)}`)
      for (const [label, value] of step.fields ?? []) console.log(`${indent}   ${fill(label)}: ${fill(value)}`)
      if (step.note) console.log(`${indent}   注意：${fill(step.note)}`)
    })
  console.log(`${tool.name} — ${fill(content.summary)}\n`)
  console.log("准备：")
  for (const item of content.prerequisites) console.log(`  - ${fill(item)}`)
  console.log("\n安装：")
  steps(content.install)
  for (const method of content.methods) {
    console.log(`\n连接方式：${method.title}${method.recommended ? "（推荐）" : ""} — ${method.verified === "lab" ? "已在实验室验证（mock 上游）" : "依据官方文档，未在实验室验证"}`)
    steps(method.steps)
  }
  console.log("\n确认已接通：")
  for (const item of content.verify) console.log(`  - ${fill(item)}`)
  console.log(`\n需要 Key 的步骤：在 Saorsa 网页「工具中心」生成，或运行 saorsa configure ${tool.id} --key --project <项目组>`)
}

async function doctor() {
  const lines: string[] = []
  const config = await loadConfig()
  const store = secretStore()
  lines.push(`Launcher ${VERSION} · ${platform().os} ${platform().arch} · 凭据存储：${store.kind}`)
  if (!config) lines.push("✗ 未登录（saorsa login --server <URL>）")
  else {
    const health = await fetch(`${config.server}/healthz`, { signal: AbortSignal.timeout(10_000) }).then((response) => response.status).catch(() => 0)
    lines.push(`${health === 200 ? "✓" : "✗"} 服务器 ${config.server}${health === 200 ? " 可访问" : " 无法访问"}`)
    const token = await store.get(config.server)
    const me = token ? await client(config, token).get<Me>("/api/launcher/me").catch((cause: Error) => cause) : undefined
    lines.push(me && !(me instanceof Error) ? `✓ 已登录：${me.user.displayName}` : `✗ 登录无效：${me instanceof Error ? me.message : "无凭据"}`)
    if (me && !(me instanceof Error) && token) {
      const probe = me.projects.flatMap((project) => project.tools.map((tool) => ({ project, tool }))).find((entry) => toolByID(entry.tool.id)?.delivery === "launch-env")
      if (probe) {
        const issued = await client(config, token).post<{ token: string }>("/api/launcher/tool-token", { toolID: probe.tool.id, projectID: probe.project.id }).catch((cause: Error) => cause)
        const models = issued instanceof Error ? 0 : await fetch(`${config.server}/gateway/v1/models`, { headers: { authorization: `Bearer ${issued.data.token}` } }).then((response) => response.status).catch(() => 0)
        lines.push(`${models === 200 ? "✓" : "✗"} 网关凭证（${toolByID(probe.tool.id)!.name}，项目组 ${probe.project.code}）${models === 200 ? "有效" : `失败（${issued instanceof Error ? issued.message : `HTTP ${models}`}）`}`)
      }
    }
  }
  for (const { tool, found } of await detectAll())
    lines.push(`  ${tool.id.padEnd(15)} ${found.installed === true ? `已安装 ${found.version ?? ""}` : found.installed === false ? "未安装" : `无法确定 ${found.note ?? ""}`}`)
  console.log(lines.join("\n"))
  await log("doctor", { lines })
  if (config) await event(null, "doctor", "succeeded", null, null)
}

async function event(toolID: string | null, action: string, outcome: "succeeded" | "failed" | "cancelled", version: string | null, detail: string | null) {
  await log(action, { toolID, outcome, version, detail })
  await session()
    .then(({ api }) => api.post("/api/launcher/events", { toolID, action, outcome, version, detail }))
    .catch(() => {})
}

async function main(argv: string[]) {
  const flags = parse(argv)
  const command = flags.positional[0]
  if (flags.flags.version || command === "version") return console.log(VERSION)
  if (!command || flags.flags.help || command === "help") return console.log(HELP)
  if (command === "login") return login(flags)
  if (command === "logout") return logout()
  if (command === "status") return status()
  if (command === "tools") return tools()
  if (command === "install" || command === "update" || command === "uninstall") return install(command, flags)
  if (command === "configure") return configure(flags)
  if (command === "restore") {
    const tool = requireTool(flags.positional[1])
    const result = await restore(tool.id)
    console.log(result.restored ? `已恢复 ${result.file}` : result.reason)
    return event(tool.id, "restore", result.restored ? "succeeded" : "cancelled", null, null)
  }
  if (command === "launch") return launch(flags)
  if (command === "doctor") return doctor()
  if (command === "guide") return guide(flags)
  throw new LauncherError(`未知命令 ${command}\n\n${HELP}`)
}

if (import.meta.main)
  await main(Bun.argv.slice(2)).catch(async (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause)
    await log("error", { message }).catch(() => {})
    console.error(`错误：${message}`)
    process.exitCode = 1
  })

export { main, parse }
