import type { ToolID } from "./tools.js"

/**
 * Step-by-step connection guides for the 12 tools, shown in the Saorsa console (and printed by the Launcher).
 *
 * Placeholders, filled per member: {origin} (this Saorsa server), {model} (a model alias the member may use with
 * the tool), {key} (a Saorsa tool key; shown once when created), {project} (billing project group code).
 * `env` entries are rendered as `export` lines for macOS/Linux and `$env:` lines for Windows PowerShell; steps with
 * `os` are shown only on that system.
 *
 * `verified: "lab"` means this repository's lab ran exactly this method against the real tool (TEST mock
 * upstream); `"docs"` means it follows the vendor's documentation and has not been run here.
 */
export interface GuideStep {
  title: string
  text?: string
  commands?: string[]
  env?: Record<string, string>
  file?: { path: string; language: "json" | "toml" | "jsonc"; content: string }
  fields?: Array<[label: string, value: string]>
  note?: string
  os?: "unix" | "windows"
}

export interface ConnectionMethod {
  id: string
  title: string
  recommended?: boolean
  verified: "lab" | "docs"
  /** Needs a Saorsa tool key generated for this member (shown with a "generate key" action). */
  needsKey: boolean
  steps: GuideStep[]
}

export interface ToolGuide {
  summary: string
  prerequisites: string[]
  install: GuideStep[]
  methods: ConnectionMethod[]
  verify: string[]
  troubleshooting: Array<{ problem: string; fix: string }>
}

const verifyInSaorsa = "回到 Saorsa「我的使用量」，能看到这次请求，工具列显示为该工具，计费为“精确”。"
const keyHint = "Saorsa Key 只显示一次；它只能用于这个工具和所选项目组，可在「个人设置 → 登录设备」中撤销。"
// `saorsa` exists only after this install; every Launcher method starts here.
const launcherSetup: GuideStep[] = [
  {
    title: "安装 Saorsa Launcher（每台电脑一次）",
    os: "windows",
    commands: ["[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm {origin}/install.ps1 | iex"],
    text: "在 PowerShell 中运行整行：开头一段为当前窗口启用 TLS 1.2（Windows PowerShell 5.1 默认未启用），然后从本服务器下载 Launcher、自动校验 SHA-256，并加入当前用户的 PATH（不需要管理员权限）。",
  },
  {
    title: "安装 Saorsa Launcher（每台电脑一次）",
    os: "unix",
    commands: ["curl -fsSL {origin}/install.sh | sh"],
    text: "在终端中运行：从本服务器下载 Launcher（macOS）、自动校验 SHA-256，并安装到 ~/.local/bin。",
  },
  {
    title: "登录 Saorsa Launcher（每台电脑一次）",
    commands: ["saorsa login --server {origin}"],
    text: "浏览器会打开授权页，确认验证码并选择默认计费项目组；凭据保存在系统钥匙串（Windows 为 DPAPI）中。提示找不到 saorsa 时，重新打开一个终端窗口再试。",
  },
]
const launcherInstallNote = "这一步需要先安装 Saorsa Launcher：Windows 在 PowerShell 运行 [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm {origin}/install.ps1 | iex，macOS 运行 curl -fsSL {origin}/install.sh | sh。"
const commonErrors = [
  { problem: "401 / 登录已失效或已在其他设备登录", fix: "Key 被撤销、过期或在另一台设备上重新签发了。重新生成 Key，或用 Launcher 重新启动。" },
  { problem: "403 tool_not_allowed", fix: "当前计费项目组没有授权这个工具，请管理员在「项目组详情 → 工具授权」中勾选。" },
  { problem: "429 no_free_key", fix: "独占模式下该模型的 Key 都在被其他成员使用。按提示换用有空闲 Key 的模型，或稍后再试。" },
  { problem: "400 model_capability_unsupported", fix: "所选模型不支持该工具需要的能力（通常是工具调用），请换一个支持工具调用的模型。" },
]

export const GUIDES: Record<ToolID, ToolGuide> = {
  opencode: {
    summary: "OpenCode 使用官方的组织登录：登录一次后，每次启动都会从 Saorsa 获取模型、价格与限制，不需要手动填写 Key。",
    prerequisites: ["macOS / Linux：系统自带 sh 与 curl", "Windows：系统自带 PowerShell 即可（Windows 10 及以上），不需要 WSL 或 Git Bash"],
    install: [
      { title: "安装 OpenCode（任选一种）", os: "unix", commands: ["npm install -g opencode-ai", "curl -fsSL https://opencode.ai/install | bash"] },
      {
        title: "安装 OpenCode（任选一种）",
        os: "windows",
        commands: ["npm install -g opencode-ai", "scoop install opencode", "choco install opencode"],
        note: "PowerShell 中的 curl 是 Invoke-WebRequest 的别名，不能运行 curl … | bash 安装脚本；请用上面任一方式。",
      },
      { title: "或使用 Saorsa Launcher 安装", commands: ["saorsa install opencode"], note: launcherInstallNote },
    ],
    methods: [
      {
        id: "login",
        title: "官方组织登录",
        recommended: true,
        verified: "lab",
        needsKey: false,
        steps: [
          { title: "在终端运行登录命令", os: "unix", commands: ["opencode auth login {origin}"] },
          {
            title: "在 PowerShell 中运行登录命令",
            os: "windows",
            commands: ["opencode auth login {origin}/windows"],
            text: "Windows 地址末尾多一个 /windows：它提供用 PowerShell 运行的登录命令（OpenCode 会显示一段 -EncodedCommand 编码的脚本，这是正常的）。登录后的模型与设置和 macOS 相同。",
          },
          { title: "在浏览器中授权", text: "浏览器会打开 Saorsa 授权页：确认终端里显示的验证码，选择计费项目组，阅读并确认使用告知。" },
          { title: "开始使用", text: "在你的项目目录运行 opencode，模型选择 saorsa/{model}（Claude 类模型为 saorsa-anthropic/…）。", commands: ["cd <你的项目目录>", "opencode"] },
        ],
      },
      {
        id: "launcher",
        title: "通过 Saorsa Launcher",
        verified: "docs",
        needsKey: false,
        steps: [
          ...launcherSetup,
          { title: "让 Launcher 运行官方登录", commands: ["saorsa configure opencode"] },
          { title: "启动", commands: ["saorsa launch opencode --dir <你的项目目录>"] },
        ],
      },
    ],
    verify: ["运行 opencode models，只应列出 saorsa/… 与 saorsa-anthropic/… 开头的模型。", verifyInSaorsa],
    troubleshooting: [
      { problem: "模型列表只剩“请重新登录”", fix: "登录已失效或已在其他设备登录，重新运行登录命令（Windows 为 opencode auth login {origin}/windows）。" },
      { problem: "Windows：spawn sh ENOENT / 'sh' is not recognized", fix: "登录地址少了 /windows（失败的登录不会保存任何内容），直接改用 opencode auth login {origin}/windows。" },
      { problem: "提示 OpenCode 版本过旧", fix: "管理员设置了最低版本，运行 opencode upgrade 后重试。" },
      ...commonErrors.slice(1),
    ],
  },

  "claude-code": {
    summary: "Claude Code 通过 Anthropic Messages 协议接入网关：把 ANTHROPIC_BASE_URL 指向 Saorsa，并用 Saorsa 凭证代替个人 API Key。",
    prerequisites: ["Node.js 18+（用 npm 安装时）", "管理员已授权 Claude Code，且项目组有 Anthropic 协议的模型"],
    install: [
      { title: "安装 Claude Code", commands: ["npm install -g @anthropic-ai/claude-code"] },
      { title: "或使用 Saorsa Launcher 安装", commands: ["saorsa install claude-code"], note: launcherInstallNote },
    ],
    methods: [
      {
        id: "launcher",
        title: "通过 Saorsa Launcher（凭证只在本次进程中，不落盘）",
        recommended: true,
        verified: "lab",
        needsKey: false,
        steps: [
          ...launcherSetup,
          { title: "启动 Claude Code", commands: ["saorsa launch claude-code --dir <你的项目目录> --model {model}"], note: "Launcher 会移除你环境中的 ANTHROPIC_API_KEY，避免个人 Key 被发送或优先使用。" },
        ],
      },
      {
        id: "env",
        title: "手动配置环境变量",
        verified: "lab",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 Claude Code 专用 Key", text: keyHint },
          { title: "设置环境变量（当前终端）", env: { ANTHROPIC_BASE_URL: "{origin}/gateway/anthropic", ANTHROPIC_AUTH_TOKEN: "{key}", ANTHROPIC_MODEL: "{model}" }, note: "如果你设置过 ANTHROPIC_API_KEY，请先取消（unset ANTHROPIC_API_KEY）。" },
          { title: "启动", commands: ["cd <你的项目目录>", "claude"] },
        ],
      },
    ],
    verify: ["在 Claude Code 中运行 /status，API 地址应为 {origin}/gateway/anthropic。", verifyInSaorsa],
    troubleshooting: [
      { problem: "启动时提示 unrecognized_model", fix: "这是 Claude Code 对网关别名的提示，不影响使用。" },
      { problem: "提示 auto mode 计费说明", fix: "经第三方网关时 auto mode 仍按旧方式计费，不影响使用。" },
      ...commonErrors,
    ],
  },

  codex: {
    summary: "Codex CLI 只支持 OpenAI Responses 协议：通过 -c 参数临时声明 Saorsa 供应商，不需要修改 ~/.codex/config.toml。",
    prerequisites: ["Node.js 18+", "项目组有 OpenAI Responses 协议的模型（网关不做 Chat→Responses 转换）"],
    install: [
      { title: "安装 Codex CLI", commands: ["npm install -g @openai/codex"] },
      { title: "或使用 Saorsa Launcher 安装", commands: ["saorsa install codex"], note: launcherInstallNote },
    ],
    methods: [
      {
        id: "launcher",
        title: "通过 Saorsa Launcher",
        recommended: true,
        verified: "lab",
        needsKey: false,
        steps: [...launcherSetup, { title: "启动 Codex", commands: ["saorsa launch codex --dir <你的项目目录> --model {model}"] }],
      },
      {
        id: "flags",
        title: "手动：命令行参数（不改配置文件）",
        verified: "lab",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 Codex CLI 专用 Key", text: keyHint },
          { title: "设置 Key 环境变量", env: { SAORSA_API_KEY: "{key}" } },
          {
            title: "启动 Codex",
            commands: [
              `codex -c 'model_providers.saorsa={name="Saorsa",base_url="{origin}/gateway/v1",env_key="SAORSA_API_KEY",wire_api="responses"}' -c 'model_provider="saorsa"' -m {model}`,
            ],
          },
        ],
      },
      {
        id: "config",
        title: "手动：写入 config.toml（长期使用）",
        verified: "docs",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 Codex CLI 专用 Key", text: keyHint },
          {
            title: "在 ~/.codex/config.toml 末尾添加",
            file: {
              path: "~/.codex/config.toml",
              language: "toml",
              content: '[model_providers.saorsa]\nname = "Saorsa"\nbase_url = "{origin}/gateway/v1"\nenv_key = "SAORSA_API_KEY"\nwire_api = "responses"\n',
            },
            note: "env_key 填的是变量名，不是 Key 本身；Key 只放在环境变量里。",
          },
          { title: "设置 Key 并启动", env: { SAORSA_API_KEY: "{key}" }, commands: ["codex -c 'model_provider=\"saorsa\"' -m {model}"] },
        ],
      },
    ],
    verify: ["Codex 启动信息中 provider 显示为 saorsa、model 为 {model}。", verifyInSaorsa],
    troubleshooting: [
      { problem: "Model metadata for … not found", fix: "Codex 对未知模型名的提示，不影响使用。" },
      { problem: "protocol_mismatch", fix: "所选模型不是 Responses 协议，换一个 OpenAI Responses 协议的模型。" },
      ...commonErrors,
    ],
  },

  "gemini-cli": {
    summary: "Gemini CLI 使用 Gemini 原生 API：GOOGLE_GEMINI_BASE_URL 指向 Saorsa，凭证以 API Key 方式发送。",
    prerequisites: ["Node.js 20+", "项目组有 Gemini 原生 API 协议的模型"],
    install: [
      { title: "安装 Gemini CLI", commands: ["npm install -g @google/gemini-cli"] },
      { title: "或使用 Saorsa Launcher 安装", commands: ["saorsa install gemini-cli"], note: launcherInstallNote },
    ],
    methods: [
      {
        id: "launcher",
        title: "通过 Saorsa Launcher",
        recommended: true,
        verified: "lab",
        needsKey: false,
        steps: [
          ...launcherSetup,
          { title: "第一次使用前选择 API Key 认证", commands: ["saorsa configure gemini-cli"], note: "会修改 ~/.gemini/settings.json 中的一项（security.auth.selectedType），修改前自动备份，可用 saorsa restore gemini-cli 撤销。" },
          { title: "启动 Gemini CLI", commands: ["saorsa launch gemini-cli --dir <你的项目目录> --model {model}"] },
        ],
      },
      {
        id: "env",
        title: "手动配置",
        verified: "lab",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 Gemini CLI 专用 Key", text: keyHint },
          { title: "在 ~/.gemini/settings.json 中选择 API Key 认证", file: { path: "~/.gemini/settings.json", language: "json", content: '{\n  "security": { "auth": { "selectedType": "gemini-api-key" } }\n}\n' }, note: "如果文件已有其他设置，只添加 security.auth.selectedType 这一项。" },
          { title: "设置环境变量", env: { GOOGLE_GEMINI_BASE_URL: "{origin}/gateway/gemini", GEMINI_API_KEY: "{key}" }, note: "如设置过 GOOGLE_API_KEY 或 GOOGLE_GENAI_USE_VERTEXAI，请先取消。" },
          { title: "启动", commands: ["cd <你的项目目录>", "gemini -m {model}"] },
        ],
      },
    ],
    verify: ["Gemini CLI 底部显示的模型为 {model}。", verifyInSaorsa],
    troubleshooting: [
      { problem: "Invalid auth method selected", fix: "settings.json 中没有选择 gemini-api-key，按上一步设置或运行 saorsa configure gemini-cli。" },
      { problem: "not running in a trusted directory（非交互模式）", fix: "在交互模式中信任该目录，或设置 GEMINI_CLI_TRUST_WORKSPACE=true。" },
      ...commonErrors,
    ],
  },

  cline: {
    summary: "Cline 是 VS Code 插件：在 Cline 设置中选择 OpenAI Compatible 供应商，填入 Saorsa 地址与 Key。",
    prerequisites: ["VS Code", "管理员已授权 Cline"],
    install: [
      { title: "安装 Cline 插件", text: "在 VS Code 扩展市场搜索 “Cline”（发布者 saoudrizwan），或：", commands: ["code --install-extension saoudrizwan.claude-dev", "saorsa install cline"], note: launcherInstallNote },
    ],
    methods: [
      {
        id: "openai",
        title: "OpenAI Compatible 供应商",
        recommended: true,
        verified: "docs",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 Cline 专用 Key", text: keyHint },
          { title: "打开 Cline 设置", text: "点击 VS Code 左侧 Cline 图标 → 右上角齿轮（Settings）。" },
          { title: "填写供应商", fields: [["API Provider", "OpenAI Compatible"], ["Base URL", "{origin}/gateway/v1"], ["API Key", "{key}"], ["Model ID", "{model}"]], note: "Base URL 不要加 /chat/completions。" },
          { title: "保存并开始对话" },
        ],
      },
      {
        id: "anthropic",
        title: "Anthropic 供应商（使用 Claude 类模型时）",
        verified: "docs",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 Cline 专用 Key", text: keyHint },
          { title: "填写供应商", fields: [["API Provider", "Anthropic"], ["勾选 Use custom base URL", "{origin}/gateway/anthropic"], ["API Key", "{key}"], ["Model", "{model}"]] },
        ],
      },
      {
        id: "cli",
        title: "Cline CLI（官方命令行版）",
        verified: "lab",
        needsKey: true,
        steps: [
          { title: "安装 Cline CLI", commands: ["npm install -g cline"] },
          { title: "在 Saorsa 生成 Cline 专用 Key", text: keyHint },
          { title: "配置并运行", commands: ["cline auth -p openai -k {key} -m {model} -b {origin}/gateway/v1", "cline \"你的任务\""] },
        ],
      },
    ],
    verify: ["在 Cline 中发一句话，能正常回复。", verifyInSaorsa],
    troubleshooting: [{ problem: "Model Not Found", fix: "Model ID 必须与 Saorsa 中的模型别名完全一致：{model}。" }, ...commonErrors],
  },

  "kilo-code": {
    summary: "Kilo Code 是 VS Code 插件：在 Providers 中添加 Custom provider，按模型协议选择 API 类型。",
    prerequisites: ["VS Code", "管理员已授权 Kilo Code"],
    install: [{ title: "安装 Kilo Code 插件", text: "在 VS Code 扩展市场搜索 “Kilo Code”，或：", commands: ["code --install-extension kilocode.kilo-code", "saorsa install kilo-code"], note: launcherInstallNote }],
    methods: [
      {
        id: "custom",
        title: "Custom provider（OpenAI Compatible）",
        recommended: true,
        verified: "docs",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 Kilo Code 专用 Key", text: keyHint },
          { title: "打开设置", text: "Kilo Code 面板 → Settings → Providers → 页面底部 Custom provider。" },
          { title: "填写", fields: [["Provider API type", "OpenAI Compatible"], ["Base URL", "{origin}/gateway/v1"], ["API Key", "{key}"], ["Model", "{model}"]], note: "Responses 协议的模型选 OpenAI Responses；Claude 类模型选 Anthropic Messages，Base URL 为 {origin}/gateway/anthropic/v1。" },
        ],
      },
      {
        id: "cli",
        title: "Kilo CLI（官方命令行版）",
        verified: "lab",
        needsKey: true,
        steps: [
          { title: "安装 Kilo CLI", commands: ["npm install -g @kilocode/cli"] },
          { title: "在 Saorsa 生成 Kilo Code 专用 Key", text: keyHint },
          {
            title: "写入配置",
            file: {
              path: "~/.config/kilo/kilo.jsonc",
              language: "jsonc",
              content: '{\n  "provider": {\n    "saorsa": {\n      "npm": "@ai-sdk/openai-compatible",\n      "name": "Saorsa",\n      "options": { "baseURL": "{origin}/gateway/v1", "apiKey": "{env:SAORSA_API_KEY}" },\n      "models": { "{model}": { "name": "{model}", "tool_call": true } }\n    }\n  },\n  "model": "saorsa/{model}"\n}\n',
            },
          },
          { title: "设置 Key 并运行", env: { SAORSA_API_KEY: "{key}" }, commands: ["kilo"] },
        ],
      },
    ],
    verify: ["在 Kilo Code 中发一句话，能正常回复。", verifyInSaorsa],
    troubleshooting: commonErrors,
  },

  "qwen-code": {
    summary: "Qwen Code 使用 OpenAI 兼容协议，只需环境变量，不修改任何文件。",
    prerequisites: ["Node.js 20+"],
    install: [
      { title: "安装 Qwen Code", commands: ["npm install -g @qwen-code/qwen-code"] },
      { title: "或使用 Saorsa Launcher 安装", commands: ["saorsa install qwen-code"], note: launcherInstallNote },
    ],
    methods: [
      {
        id: "launcher",
        title: "通过 Saorsa Launcher",
        recommended: true,
        verified: "lab",
        needsKey: false,
        steps: [...launcherSetup, { title: "启动 Qwen Code", commands: ["saorsa launch qwen-code --dir <你的项目目录> --model {model}"] }],
      },
      {
        id: "env",
        title: "手动配置环境变量",
        verified: "lab",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 Qwen Code 专用 Key", text: keyHint },
          { title: "设置环境变量", env: { OPENAI_BASE_URL: "{origin}/gateway/v1", OPENAI_API_KEY: "{key}", OPENAI_MODEL: "{model}", QWEN_DEFAULT_AUTH_TYPE: "openai" } },
          { title: "启动", commands: ["cd <你的项目目录>", "qwen"] },
        ],
      },
    ],
    verify: ["Qwen Code 显示的模型为 {model}。", verifyInSaorsa],
    troubleshooting: commonErrors,
  },

  trae: {
    summary: "TRAE 在“模型 → 添加模型”中支持自定义 OpenAI 兼容模型。TRAE 的内置模型、补全与云端功能不经过 Saorsa。",
    prerequisites: ["TRAE 账户（国际版或 TRAE CN）", "管理员已授权 TRAE"],
    install: [{ title: "下载安装 TRAE", text: "从官网下载：https://www.trae.ai/download（Launcher 不会自动安装 IDE）" }],
    methods: [
      {
        id: "custom-model",
        title: "添加自定义模型",
        recommended: true,
        verified: "docs",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 TRAE 专用 Key", text: keyHint },
          { title: "打开模型设置", text: "TRAE 对话面板右上角设置 → 模型 → 添加模型 → 自定义配置。" },
          { title: "填写", fields: [["服务商 / API 格式", "OpenAI 兼容（Chat Completions）"], ["请求地址", "{origin}/gateway/v1/chat/completions"], ["模型 ID", "{model}"], ["API Key", "{key}"]], note: "较新版本把请求地址原样使用，需要填写到 /chat/completions；如果你的版本会自动补全路径，则填 {origin}/gateway/v1。不同版本与国际版/CN 版字段可能不同。" },
        ],
      },
    ],
    verify: ["在 TRAE 对话中选择刚添加的模型并发送一句话。", verifyInSaorsa],
    troubleshooting: [{ problem: "403 权限错误", fix: "模型 ID 必须与 Saorsa 中的别名完全一致：{model}。" }, ...commonErrors],
  },

  qoder: {
    summary: "Qoder 的自定义模型（BYOK）取决于你的 Qoder 账户套餐；当前官方文档只提供交互式配置向导，是否接受任意 Base URL 尚未得到确认。",
    prerequisites: ["Qoder 账户，且套餐支持 BYOK", "管理员已授权 Qoder"],
    install: [{ title: "下载安装 Qoder", text: "从官网下载：https://qoder.com/download（Launcher 不会自动安装 IDE）" }],
    methods: [
      {
        id: "byok",
        title: "Qoder CLI 的 BYOK 向导（尝试）",
        verified: "docs",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 Qoder 专用 Key", text: keyHint },
          { title: "打开 BYOK 向导", text: "在 Qoder CLI 中输入 /model，切换到 Custom 页签，按向导添加模型。官方文档提示不要手动编辑 settings.json。" },
          { title: "如向导提供自定义地址，填写", fields: [["格式", "OpenAI 兼容"], ["Base URL", "{origin}/gateway/v1"], ["API Key", "{key}"], ["模型", "{model}"]] },
        ],
      },
    ],
    verify: ["如果向导不提供自定义地址，说明当前版本不能接入 Saorsa，请联系管理员。", verifyInSaorsa],
    troubleshooting: commonErrors,
  },

  "jetbrains-ai": {
    summary: "JetBrains AI Assistant 支持 BYOK 接入 OpenAI 兼容端点。部分功能仍需要 JetBrains AI 订阅，JetBrains 托管的模型与补全不经过 Saorsa。",
    prerequisites: ["JetBrains IDE 2025.x 或更新版本", "JetBrains AI Assistant 插件", "管理员已授权 JetBrains AI Assistant"],
    install: [{ title: "安装插件", text: "IDE 中 Settings → Plugins → Marketplace 搜索 “JetBrains AI Assistant”，或访问 https://plugins.jetbrains.com/plugin/22282-jetbrains-ai-assistant" }],
    methods: [
      {
        id: "byok",
        title: "第三方 AI 供应商（OpenAI-compatible）",
        recommended: true,
        verified: "docs",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 JetBrains AI Assistant 专用 Key", text: keyHint },
          { title: "打开设置", text: "Settings → Tools → AI Assistant → Models & API Keys → Third-party AI providers。" },
          { title: "填写", fields: [["Provider", "OpenAI-compatible"], ["URL", "{origin}/gateway/v1"], ["API Key", "{key}"]] },
          { title: "测试连接并选择模型", text: "点 Test Connection，然后在 AI Chat 的模型选择中选择 {model}。" },
        ],
      },
    ],
    verify: ["窗口顶部 JetBrains AI 组件显示第三方供应商已启用。", verifyInSaorsa],
    troubleshooting: [{ problem: "部分功能不可用", fix: "这些功能需要 JetBrains AI 订阅或只支持 JetBrains 托管模型，不经过 Saorsa。" }, ...commonErrors],
  },

  "github-copilot": {
    summary: "Copilot CLI 用 BYOK 环境变量接入（已在实验中验证）；VS Code 中的 Copilot Chat 可在“Manage Language Models”中添加自定义端点。行内补全与 NES 始终使用 GitHub 自己的服务。",
    prerequisites: ["Copilot CLI：Node.js 22+", "VS Code Copilot Chat：组织策略允许 BYOK", "所选模型必须支持工具调用与流式"],
    install: [
      { title: "安装 Copilot CLI", commands: ["npm install -g @github/copilot"] },
      { title: "或使用 Saorsa Launcher 安装", commands: ["saorsa install github-copilot"], note: launcherInstallNote },
    ],
    methods: [
      {
        id: "launcher",
        title: "Copilot CLI · 通过 Saorsa Launcher",
        recommended: true,
        verified: "lab",
        needsKey: false,
        steps: [...launcherSetup, { title: "启动 Copilot CLI", commands: ["saorsa launch github-copilot --dir <你的项目目录> --model {model}"] }],
      },
      {
        id: "cli-env",
        title: "Copilot CLI · 手动配置环境变量",
        verified: "lab",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 GitHub Copilot 专用 Key", text: keyHint },
          { title: "设置环境变量", env: { COPILOT_PROVIDER_BASE_URL: "{origin}/gateway/v1", COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_API_KEY: "{key}", COPILOT_MODEL: "{model}" } },
          { title: "启动", commands: ["cd <你的项目目录>", "copilot"] },
        ],
      },
      {
        id: "vscode",
        title: "VS Code Copilot Chat · 自定义端点",
        verified: "docs",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 GitHub Copilot 专用 Key", text: keyHint },
          { title: "添加模型", text: "Copilot Chat 模型选择器 → Manage Language Models → 添加 Custom Endpoint。" },
          { title: "填写", fields: [["API 类型", "Chat Completions"], ["Endpoint URL", "{origin}/gateway/v1"], ["API Key", "{key}"], ["Model", "{model}"]], note: "模型若未声明工具调用能力，不会出现在 Agent 模式中。" },
        ],
      },
    ],
    verify: ["Copilot CLI 启动后发送一句话能正常回复。", verifyInSaorsa],
    troubleshooting: [{ problem: "行内补全没有出现在 Saorsa 用量里", fix: "行内补全与 NES 始终由 GitHub 提供，不经过 Saorsa，这是预期行为。" }, ...commonErrors],
  },

  cursor: {
    summary: "Cursor 支持用自己的 OpenAI Key 并覆盖 Base URL。请求由 Cursor 云端转发，因此 Saorsa 网关必须能从公网访问；Tab 补全与 Cursor 自有模型不经过 Saorsa。",
    prerequisites: ["Cursor 账户（Agent / Edit 使用自有 Key 需要付费套餐）", "Saorsa 网关可从公网访问（HTTPS）", "管理员已授权 Cursor"],
    install: [{ title: "下载安装 Cursor", text: "从官网下载：https://cursor.com/downloads（Launcher 不会自动安装 IDE）" }],
    methods: [
      {
        id: "override",
        title: "OpenAI API Key + Override Base URL",
        recommended: true,
        verified: "docs",
        needsKey: true,
        steps: [
          { title: "在 Saorsa 生成 Cursor 专用 Key", text: keyHint },
          { title: "打开设置", text: "Cursor Settings → Models → API Keys。" },
          { title: "填写", fields: [["OpenAI API Key", "{key}"], ["Override OpenAI Base URL", "{origin}/gateway/v1"], ["添加自定义模型", "{model}"]], note: "点 Verify 验证后，在模型列表中只启用 {model}。" },
          { title: "长时间使用前检查开关", text: "有用户反馈“使用自己的 Key”开关会被静默关闭，导致请求改由 Cursor 计费；每次长时间会话前请确认它仍是打开的。" },
        ],
      },
    ],
    verify: ["在 Cursor 的 Ask 模式中选择 {model} 发送一句话。", verifyInSaorsa],
    troubleshooting: [
      { problem: "Agent 模式报错而 Ask 模式正常", fix: "Cursor 论坛反馈 Agent 模式会对自定义 Base URL 发送 Responses 格式请求；可以改用 Ask 模式，或使用 Responses 协议的模型。" },
      { problem: "Saorsa 中看不到请求", fix: "检查“使用自己的 Key”开关是否仍然打开，以及网关能否被公网访问。" },
      ...commonErrors,
    ],
  },
}
