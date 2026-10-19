/**
 * The fixed Saorsa tool catalog: exactly these 12 tools, no others. Shared by the server (tool center,
 * entitlements, request attribution) and the Launcher (detection, installation, configuration, launch).
 *
 * Profiles are reviewed code. Install commands and config templates are never received from a server or the
 * database, so a compromised server cannot make a Launcher run arbitrary commands.
 *
 * Statements about vendor behaviour cite the official documentation checked on `docsCheckedAt`. `lab` records
 * only what this repository's own automated tests actually ran (against the TEST-labelled mock upstream);
 * a tool without a `lab` entry has not been verified here.
 */

export type ToolID =
  | "opencode"
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "cline"
  | "kilo-code"
  | "qwen-code"
  | "trae"
  | "qoder"
  | "jetbrains-ai"
  | "github-copilot"
  | "cursor"

/** Wire protocols the Saorsa gateway serves. A tool may support several. */
export type GatewayProtocol = "openai-chat" | "anthropic-messages" | "openai-responses" | "gemini"

export type Form = "cli" | "ide-extension" | "ide" | "desktop"

/** How the tool installs from its official source. Only these fixed kinds exist; there is no free-form command. */
export type Installer =
  | { kind: "npm"; package: string }
  | { kind: "vscode-extension"; id: string }
  | { kind: "download"; url: string }
  | { kind: "jetbrains-plugin"; id: string; url: string }

export type Detector =
  | { kind: "command"; command: string; versionArgs: string[] }
  | { kind: "vscode-extension"; id: string }
  | { kind: "app"; macos: string[]; windows: string[] }
  | { kind: "jetbrains-plugin"; id: string }

/** How a member's Saorsa credential reaches the tool. */
export type CredentialDelivery =
  /** The Launcher passes a short-lived token to the child process environment at launch; nothing is stored. */
  | "launch-env"
  /** OpenCode's own `opencode auth login <saorsa>` flow stores a project-bound token in OpenCode's auth store. */
  | "opencode-login"
  /** The member pastes a revocable, tool-bound Saorsa key into the tool's own settings UI. */
  | "ide-key"

export interface GatewayRoute {
  protocol: GatewayProtocol
  /** Base URL relative to the Saorsa origin, in the form this tool expects. */
  basePath: string
  /** What the member or Launcher sets. Values in {braces} are filled by Saorsa. */
  settings: Record<string, string>
}

export interface ToolProfile {
  id: ToolID
  name: string
  vendor: string
  homepage: string
  /** Official pages the profile is based on. */
  sources: string[]
  docsCheckedAt: string
  forms: Form[]
  /** Platforms the vendor supports for this form (from vendor docs, not tested here unless `lab` says so). */
  platforms: { macos: Array<"arm64" | "x64">; windows: Array<"x64"> }
  install: Installer
  detect: Detector
  /** Whether the Launcher may install/update/uninstall it itself (npm and VS Code extensions only). */
  autoInstall: boolean
  routes: GatewayRoute[]
  delivery: CredentialDelivery
  /** Model capabilities the tool needs for its agent features. */
  requires: { tools: boolean; streaming: boolean }
  /** A vendor account or subscription is still needed for at least some capability. */
  officialAccount: string | null
  /** Capabilities that never pass through the Saorsa gateway (not metered, not governed). */
  unmanaged: string[]
  /** Known gaps that make some features unusable through the gateway. */
  limitations: string[]
  /** How the Launcher starts the tool with Saorsa. Absent: the Launcher cannot start it (configure it by hand). */
  launch?: LaunchRecipe
  /** Extracts the tool version from a gateway request's User-Agent, when the tool sends one we recognise. */
  userAgent?: RegExp
  lab?: LabRecord
}

/**
 * A reviewed recipe for starting a tool. Values may use {origin}, {token} (the short-lived per-launch token),
 * {model} and {dir}; nothing else is substituted and no shell is involved.
 */
export type LaunchRecipe =
  | {
      kind: "process"
      command: string
      args: string[]
      env: Record<string, string>
      /** Inherited variables removed from the child so a personal key is never sent to Saorsa or used instead. */
      unsetEnv: string[]
      /** One-time setup the member must approve first (`saorsa configure <tool>`). */
      configure?: "gemini-auth" | "opencode-login"
    }
  /** Opens the IDE on the chosen folder; the member configures the Saorsa key in the IDE's own settings. */
  | { kind: "ide"; editor: "vscode" | "cursor" | "trae" | "qoder" }

/** What this repository's tests actually exercised for a tool. */
export interface LabRecord {
  version: string
  platform: string
  date: string
  upstream: "mock"
  test: string
  checks: Partial<Record<LabCheck, boolean>>
  notes?: string
}

export type LabCheck = "install" | "launch" | "auth" | "endpoint" | "request" | "stream" | "toolUse" | "usage" | "cost" | "attribution"

const ORIGIN = "{origin}"

export const TOOLS: ToolProfile[] = [
  {
    id: "opencode",
    name: "OpenCode",
    vendor: "SST / Anomaly",
    homepage: "https://opencode.ai",
    sources: ["https://opencode.ai/docs/config/", "https://opencode.ai/docs/providers/"],
    docsCheckedAt: "2026-10-18",
    forms: ["cli", "desktop"],
    platforms: { macos: ["arm64", "x64"], windows: ["x64"] },
    install: { kind: "npm", package: "opencode-ai" },
    detect: { kind: "command", command: "opencode", versionArgs: ["--version"] },
    autoInstall: true,
    routes: [
      { protocol: "openai-chat", basePath: "/gateway/v1", settings: { login: `opencode auth login ${ORIGIN}` } },
      { protocol: "anthropic-messages", basePath: "/gateway/anthropic/v1", settings: { login: `opencode auth login ${ORIGIN}` } },
    ],
    delivery: "opencode-login",
    launch: { kind: "process", command: "opencode", args: [], env: {}, unsetEnv: [], configure: "opencode-login" },
    requires: { tools: true, streaming: true },
    officialAccount: null,
    unmanaged: ["Providers the member configures outside Saorsa (blocked when 'managed models only' is on)"],
    limitations: ["Model and price changes reach OpenCode 1.x on its next start", "Windows logs in at <origin>/windows (PowerShell login command); macOS/Linux use sh and curl"],
    userAgent: /\bopencode\/(\d+\.\d+\.\d+)/,
    lab: {
      version: "1.17.0",
      platform: "macOS 27.2 arm64",
      date: "2026-10-18",
      upstream: "mock",
      test: "server/test/lab.test.ts",
      checks: { launch: true, auth: true, endpoint: true, request: true, stream: true, toolUse: true, usage: true, cost: true, attribution: true },
      notes: "the official `opencode auth login` well-known flow, then `opencode run` with a Read tool round trip",
    },
  },
  {
    id: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    homepage: "https://claude.com/product/claude-code",
    sources: ["https://code.claude.com/docs/en/llm-gateway", "https://code.claude.com/docs/en/llm-gateway-protocol"],
    docsCheckedAt: "2026-10-18",
    forms: ["cli", "ide-extension"],
    platforms: { macos: ["arm64", "x64"], windows: ["x64"] },
    install: { kind: "npm", package: "@anthropic-ai/claude-code" },
    detect: { kind: "command", command: "claude", versionArgs: ["--version"] },
    autoInstall: true,
    routes: [
      {
        protocol: "anthropic-messages",
        basePath: "/gateway/anthropic",
        settings: { ANTHROPIC_BASE_URL: `${ORIGIN}/gateway/anthropic`, ANTHROPIC_AUTH_TOKEN: "{token}", ANTHROPIC_MODEL: "{model}" },
      },
    ],
    delivery: "launch-env",
    launch: {
      kind: "process",
      command: "claude",
      args: [],
      env: { ANTHROPIC_BASE_URL: `${ORIGIN}/gateway/anthropic`, ANTHROPIC_AUTH_TOKEN: "{token}", ANTHROPIC_MODEL: "{model}" },
      unsetEnv: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"],
    },
    requires: { tools: true, streaming: true },
    officialAccount: null,
    unmanaged: [
      "Fast-mode availability checks and the WebFetch domain safety check call api.anthropic.com directly (per Anthropic's gateway guide)",
    ],
    limitations: [
      "Anthropic supports Claude models only behind a gateway; other models may reject Claude Code's request fields",
      "Gateway aliases unknown to Claude Code are treated as current Claude models (adaptive thinking, effort fields); it logs an 'unrecognized_model' notice",
      "Auto-mode classifier requests through a third-party gateway keep the older billing behaviour (Claude Code prints a notice)",
    ],
    userAgent: /\bclaude-cli\/(\d+\.\d+\.\d+)/,
    lab: {
      version: "2.1.292",
      platform: "macOS 27.2 arm64",
      date: "2026-10-18",
      upstream: "mock",
      test: "server/test/lab.test.ts",
      checks: { launch: true, auth: true, endpoint: true, request: true, stream: true, toolUse: true, usage: true, cost: true, attribution: true },
      notes: "`claude -p` with ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN; Read tool round trip",
    },
  },
  {
    id: "codex",
    name: "Codex CLI",
    vendor: "OpenAI",
    homepage: "https://developers.openai.com/codex/cli",
    sources: ["https://developers.openai.com/codex/config-reference", "https://github.com/openai/codex/blob/main/docs/config.md"],
    docsCheckedAt: "2026-10-18",
    forms: ["cli", "ide-extension"],
    platforms: { macos: ["arm64", "x64"], windows: ["x64"] },
    install: { kind: "npm", package: "@openai/codex" },
    detect: { kind: "command", command: "codex", versionArgs: ["--version"] },
    autoInstall: true,
    routes: [
      {
        protocol: "openai-responses",
        basePath: "/gateway/v1",
        settings: {
          "codex -c (provider)": 'model_providers.saorsa={name="Saorsa",base_url="{origin}/gateway/v1",env_key="SAORSA_API_KEY",wire_api="responses"}',
          "codex -c (select)": 'model_provider="saorsa"',
          SAORSA_API_KEY: "{token}",
        },
      },
    ],
    delivery: "launch-env",
    // The provider is passed on the command line, so the member's ~/.codex/config.toml is never edited.
    launch: {
      kind: "process",
      command: "codex",
      args: [
        "-c",
        `model_providers.saorsa={name="Saorsa",base_url="${ORIGIN}/gateway/v1",env_key="SAORSA_API_KEY",wire_api="responses"}`,
        "-c",
        'model_provider="saorsa"',
        "-m",
        "{model}",
      ],
      env: { SAORSA_API_KEY: "{token}" },
      unsetEnv: [],
    },
    requires: { tools: true, streaming: true },
    officialAccount: null,
    unmanaged: ["ChatGPT-account features (cloud tasks, ChatGPT sign-in) are outside the gateway"],
    limitations: ["Current Codex releases speak only the OpenAI Responses API; the upstream provider must support Responses"],
    userAgent: /\bcodex_[a-z_]+\/(\d+\.\d+\.\d+)/,
    lab: {
      version: "0.163.0",
      platform: "macOS 27.2 arm64",
      date: "2026-10-18",
      upstream: "mock",
      test: "server/test/lab.test.ts",
      checks: { launch: true, auth: true, endpoint: true, request: true, stream: true, toolUse: true, usage: true, cost: true, attribution: true },
      notes: "`codex exec -s read-only` with a [model_providers] Responses entry; shell tool ran `cat` in the sandbox",
    },
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    vendor: "Google",
    homepage: "https://github.com/google-gemini/gemini-cli",
    sources: ["https://geminicli.com/docs/get-started/authentication"],
    docsCheckedAt: "2026-10-18",
    forms: ["cli"],
    platforms: { macos: ["arm64", "x64"], windows: ["x64"] },
    install: { kind: "npm", package: "@google/gemini-cli" },
    detect: { kind: "command", command: "gemini", versionArgs: ["--version"] },
    autoInstall: true,
    routes: [
      {
        protocol: "gemini",
        basePath: "/gateway/gemini",
        settings: { GOOGLE_GEMINI_BASE_URL: `${ORIGIN}/gateway/gemini`, GEMINI_API_KEY: "{token}", "gemini -m": "{model}", "~/.gemini/settings.json": 'security.auth.selectedType = "gemini-api-key"' },
      },
    ],
    delivery: "launch-env",
    launch: {
      kind: "process",
      command: "gemini",
      args: ["-m", "{model}"],
      env: { GOOGLE_GEMINI_BASE_URL: `${ORIGIN}/gateway/gemini`, GEMINI_API_KEY: "{token}" },
      unsetEnv: ["GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_GCA", "GOOGLE_CLOUD_PROJECT"],
      // Gemini CLI only honours system settings files owned by root, so API-key auth has to be selected in the
      // member's own settings.json (backed up first and restorable with `saorsa restore gemini-cli`).
      configure: "gemini-auth",
    },
    requires: { tools: true, streaming: true },
    officialAccount: null,
    unmanaged: ["Google-account (OAuth) sign-in and Code Assist quotas are outside the gateway"],
    limitations: [
      "Speaks the Gemini native API only; the upstream provider must be Google's Gemini API (or a compatible service)",
      "GOOGLE_GEMINI_BASE_URL is read by the Google GenAI SDK the CLI uses; Gemini CLI's own auth guide does not list it",
    ],
    userAgent: /\bGeminiCLI(?:-[a-z]+)?\/(\d+\.\d+\.\d+)/,
    lab: {
      version: "0.64.0",
      platform: "macOS 27.2 arm64",
      date: "2026-10-18",
      upstream: "mock",
      test: "server/test/lab.test.ts",
      checks: { launch: true, auth: true, endpoint: true, request: true, stream: true, toolUse: true, usage: true, cost: true, attribution: true },
      notes: "`gemini -p` with GOOGLE_GEMINI_BASE_URL/GEMINI_API_KEY; read_file tool round trip; key sent as x-goog-api-key",
    },
  },
  {
    id: "cline",
    name: "Cline",
    vendor: "Cline Bot Inc.",
    homepage: "https://cline.bot",
    sources: ["https://docs.cline.bot/provider-config/openai-compatible"],
    docsCheckedAt: "2026-10-18",
    forms: ["ide-extension"],
    platforms: { macos: ["arm64", "x64"], windows: ["x64"] },
    install: { kind: "vscode-extension", id: "saoudrizwan.claude-dev" },
    detect: { kind: "vscode-extension", id: "saoudrizwan.claude-dev" },
    autoInstall: true,
    routes: [
      { protocol: "openai-chat", basePath: "/gateway/v1", settings: { "API Provider": "OpenAI Compatible", "Base URL": `${ORIGIN}/gateway/v1`, "API Key": "{ide-key}", "Model ID": "{model}" } },
      { protocol: "anthropic-messages", basePath: "/gateway/anthropic", settings: { "API Provider": "Anthropic", "Custom base URL": `${ORIGIN}/gateway/anthropic`, "API Key": "{ide-key}" } },
    ],
    delivery: "ide-key",
    launch: { kind: "ide", editor: "vscode" },
    requires: { tools: true, streaming: true },
    officialAccount: null,
    unmanaged: ["Cline account features (Cline provider credits, cloud features)"],
    limitations: ["Configured in the VS Code UI; the key is stored in VS Code's secret storage by the extension"],
    lab: {
      version: "3.0.73",
      platform: "macOS 27.2 arm64",
      date: "2026-10-18",
      upstream: "mock",
      test: "server/test/lab.test.ts",
      checks: { launch: true, auth: true, endpoint: true, request: true, stream: true, toolUse: true, usage: true, cost: true, attribution: true },
      notes: "Official Cline CLI (`cline auth -p openai -b …`, then a task); read_files tool round trip. The VS Code extension UI was not driven",
    },
  },
  {
    id: "kilo-code",
    name: "Kilo Code",
    vendor: "Kilo Code",
    homepage: "https://kilo.ai",
    sources: ["https://kilo.ai/docs/ai-providers/openai-compatible", "https://kilo.ai/docs/code-with-ai/agents/custom-models"],
    docsCheckedAt: "2026-10-18",
    forms: ["ide-extension"],
    platforms: { macos: ["arm64", "x64"], windows: ["x64"] },
    install: { kind: "vscode-extension", id: "kilocode.kilo-code" },
    detect: { kind: "vscode-extension", id: "kilocode.kilo-code" },
    autoInstall: true,
    routes: [
      { protocol: "openai-chat", basePath: "/gateway/v1", settings: { Provider: "Custom provider · OpenAI Compatible", "Base URL": `${ORIGIN}/gateway/v1`, "API Key": "{ide-key}", Model: "{model}" } },
      { protocol: "openai-responses", basePath: "/gateway/v1", settings: { Provider: "Custom provider · OpenAI Responses", "Base URL": `${ORIGIN}/gateway/v1`, "API Key": "{ide-key}" } },
      { protocol: "anthropic-messages", basePath: "/gateway/anthropic/v1", settings: { Provider: "Custom provider · Anthropic Messages", "Base URL": `${ORIGIN}/gateway/anthropic/v1`, "API Key": "{ide-key}" } },
    ],
    delivery: "ide-key",
    launch: { kind: "ide", editor: "vscode" },
    requires: { tools: true, streaming: true },
    officialAccount: null,
    unmanaged: ["Kilo account features (Kilo Gateway credits, cloud agents)"],
    limitations: ["Configured in the VS Code UI"],
    userAgent: /\bKilo-Code\/(\d+\.\d+\.\d+)/,
    lab: {
      version: "7.8.12",
      platform: "macOS 27.2 arm64",
      date: "2026-10-18",
      upstream: "mock",
      test: "server/test/lab.test.ts",
      checks: { launch: true, auth: true, endpoint: true, request: true, stream: true, toolUse: true, usage: true, cost: true, attribution: true },
      notes: "Official Kilo CLI (`kilo run`) with an OpenAI-compatible provider in kilo.jsonc; Read tool round trip. The VS Code extension UI was not driven",
    },
  },
  {
    id: "qwen-code",
    name: "Qwen Code",
    vendor: "Alibaba Qwen",
    homepage: "https://github.com/QwenLM/qwen-code",
    sources: ["https://qwenlm.github.io/qwen-code-docs/zh/users/configuration/model-providers/"],
    docsCheckedAt: "2026-10-18",
    forms: ["cli"],
    platforms: { macos: ["arm64", "x64"], windows: ["x64"] },
    install: { kind: "npm", package: "@qwen-code/qwen-code" },
    detect: { kind: "command", command: "qwen", versionArgs: ["--version"] },
    autoInstall: true,
    routes: [
      { protocol: "openai-chat", basePath: "/gateway/v1", settings: { OPENAI_BASE_URL: `${ORIGIN}/gateway/v1`, OPENAI_API_KEY: "{token}", OPENAI_MODEL: "{model}", QWEN_DEFAULT_AUTH_TYPE: "openai" } },
    ],
    delivery: "launch-env",
    launch: {
      kind: "process",
      command: "qwen",
      args: [],
      env: { OPENAI_BASE_URL: `${ORIGIN}/gateway/v1`, OPENAI_API_KEY: "{token}", OPENAI_MODEL: "{model}", QWEN_DEFAULT_AUTH_TYPE: "openai" },
      unsetEnv: ["DASHSCOPE_API_KEY"],
    },
    requires: { tools: true, streaming: true },
    officialAccount: null,
    unmanaged: ["Qwen OAuth sign-in quotas are outside the gateway"],
    limitations: [],
    userAgent: /\bQwenCode\/(\d+\.\d+\.\d+)/,
    lab: {
      version: "0.25.2",
      platform: "macOS 27.2 arm64",
      date: "2026-10-18",
      upstream: "mock",
      test: "server/test/lab.test.ts",
      checks: { launch: true, auth: true, endpoint: true, request: true, stream: true, toolUse: true, usage: true, cost: true, attribution: true },
      notes: "`qwen -p` with OPENAI_BASE_URL/OPENAI_API_KEY/OPENAI_MODEL; read_file tool round trip",
    },
  },
  {
    id: "trae",
    name: "TRAE",
    vendor: "ByteDance",
    homepage: "https://www.trae.ai",
    sources: ["https://docs.trae.ai/ide/models"],
    docsCheckedAt: "2026-10-18",
    forms: ["ide"],
    platforms: { macos: ["arm64", "x64"], windows: ["x64"] },
    install: { kind: "download", url: "https://www.trae.ai/download" },
    detect: { kind: "app", macos: ["/Applications/Trae.app", "/Applications/Trae CN.app"], windows: ["%LOCALAPPDATA%\\Programs\\Trae\\Trae.exe"] },
    autoInstall: false,
    routes: [
      { protocol: "openai-chat", basePath: "/gateway/v1", settings: { "Models › Add Model": "Custom config, OpenAI-compatible", URL: `${ORIGIN}/gateway/v1/chat/completions`, "API Key": "{ide-key}", "Model ID": "{model}" } },
    ],
    delivery: "ide-key",
    launch: { kind: "ide", editor: "trae" },
    requires: { tools: true, streaming: true },
    officialAccount: "A TRAE account is required to use the IDE",
    unmanaged: ["Built-in TRAE models, code completion and cloud features use TRAE's own service"],
    limitations: ["Custom-model support and fields differ between TRAE international and TRAE CN editions and between versions"],
  },
  {
    id: "qoder",
    name: "Qoder",
    vendor: "Alibaba",
    homepage: "https://qoder.com",
    sources: ["https://docs.qoder.com/user-guide/chat/custom-models", "https://docs.qoder.com/cli/custom-models"],
    docsCheckedAt: "2026-10-18",
    forms: ["ide", "cli"],
    platforms: { macos: ["arm64", "x64"], windows: ["x64"] },
    install: { kind: "download", url: "https://qoder.com/download" },
    detect: { kind: "app", macos: ["/Applications/Qoder.app"], windows: ["%LOCALAPPDATA%\\Programs\\Qoder\\Qoder.exe"] },
    autoInstall: false,
    routes: [
      { protocol: "openai-chat", basePath: "/gateway/v1", settings: { "Qoder CLI /model › Custom (BYOK wizard)": "OpenAI-compatible, base URL {origin}/gateway/v1, API key {ide-key}" } },
    ],
    delivery: "ide-key",
    launch: { kind: "ide", editor: "qoder" },
    requires: { tools: true, streaming: true },
    officialAccount: "A Qoder account whose plan includes BYOK is required; the IDE's BYOK lists only Qoder's own provider choices",
    unmanaged: ["The Qoder IDE's built-in models and agents use Qoder's service"],
    limitations: [
      "Current Qoder docs configure BYOK only through the interactive /model wizard and warn against editing settings.json",
      "Whether an arbitrary OpenAI-compatible base URL (such as Saorsa) is accepted is not confirmed by the current docs",
    ],
  },
  {
    id: "jetbrains-ai",
    name: "JetBrains AI Assistant",
    vendor: "JetBrains",
    homepage: "https://www.jetbrains.com/ai-assistant/",
    sources: ["https://www.jetbrains.com/help/ai-assistant/bring-your-own-key-byok.html"],
    docsCheckedAt: "2026-10-18",
    forms: ["ide-extension"],
    platforms: { macos: ["arm64", "x64"], windows: ["x64"] },
    install: { kind: "jetbrains-plugin", id: "com.intellij.ml.llm", url: "https://plugins.jetbrains.com/plugin/22282-jetbrains-ai-assistant" },
    detect: { kind: "jetbrains-plugin", id: "com.intellij.ml.llm" },
    autoInstall: false,
    routes: [
      { protocol: "openai-chat", basePath: "/gateway/v1", settings: { "Settings › Tools › AI Assistant › Models & API Keys": "Third-party AI providers › OpenAI-compatible", URL: `${ORIGIN}/gateway/v1`, "API Key": "{ide-key}" } },
    ],
    delivery: "ide-key",
    requires: { tools: true, streaming: true },
    officialAccount: "Some AI Assistant features require a JetBrains AI subscription even with BYOK",
    unmanaged: ["JetBrains-hosted models, cloud code completion and features not covered by BYOK"],
    limitations: ["BYOK accepts OpenAI-compatible endpoints; not every chat-completions model works in every AI Assistant mode"],
  },
  {
    id: "github-copilot",
    name: "GitHub Copilot",
    vendor: "GitHub",
    homepage: "https://github.com/features/copilot",
    sources: [
      "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models",
      "https://github.blog/changelog/2026-04-22-bring-your-own-language-model-key-in-vs-code-now-available/",
    ],
    docsCheckedAt: "2026-10-18",
    forms: ["cli", "ide-extension"],
    platforms: { macos: ["arm64", "x64"], windows: ["x64"] },
    install: { kind: "npm", package: "@github/copilot" },
    detect: { kind: "command", command: "copilot", versionArgs: ["--version"] },
    autoInstall: true,
    routes: [
      {
        protocol: "openai-chat",
        basePath: "/gateway/v1",
        settings: { COPILOT_PROVIDER_BASE_URL: `${ORIGIN}/gateway/v1`, COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_API_KEY: "{token}", COPILOT_MODEL: "{model}" },
      },
    ],
    delivery: "launch-env",
    // Copilot CLI only; Copilot Chat in VS Code is configured in VS Code's "Manage Language Models".
    launch: {
      kind: "process",
      command: "copilot",
      args: [],
      env: { COPILOT_PROVIDER_BASE_URL: `${ORIGIN}/gateway/v1`, COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_API_KEY: "{token}", COPILOT_MODEL: "{model}" },
      unsetEnv: ["COPILOT_PROVIDER_BEARER_TOKEN"],
    },
    requires: { tools: true, streaming: true },
    officialAccount: "Inline suggestions and next edit suggestions in VS Code always use GitHub's service and need a GitHub sign-in",
    unmanaged: ["Inline completions and NES in VS Code", "GitHub-hosted Copilot models and premium requests"],
    limitations: ["Copilot CLI BYOK requires a model with tool calling and streaming", "Organization policy can disable BYOK in VS Code"],
    userAgent: /\bcopilot\/(\d+\.\d+\.\d+)/i,
    lab: {
      version: "1.0.98",
      platform: "macOS 27.2 arm64",
      date: "2026-10-18",
      upstream: "mock",
      test: "server/test/lab.test.ts",
      checks: { launch: true, auth: true, endpoint: true, request: true, stream: true, toolUse: true, usage: true, cost: true, attribution: true },
      notes: "Copilot CLI BYOK (`copilot -p`, COPILOT_PROVIDER_* and COPILOT_OFFLINE=true); view tool round trip. VS Code Copilot Chat BYOK not tested",
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    vendor: "Anysphere",
    homepage: "https://cursor.com",
    sources: ["https://docs.cursor.com/settings/api-keys"],
    docsCheckedAt: "2026-10-18",
    forms: ["ide"],
    platforms: { macos: ["arm64", "x64"], windows: ["x64"] },
    install: { kind: "download", url: "https://cursor.com/downloads" },
    detect: { kind: "app", macos: ["/Applications/Cursor.app"], windows: ["%LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe"] },
    autoInstall: false,
    routes: [
      { protocol: "openai-chat", basePath: "/gateway/v1", settings: { "Settings › Models › OpenAI API Key": "{ide-key}", "Override OpenAI Base URL": `${ORIGIN}/gateway/v1`, "Custom model": "{model}" } },
    ],
    delivery: "ide-key",
    launch: { kind: "ide", editor: "cursor" },
    requires: { tools: true, streaming: true },
    officialAccount: "A Cursor account is required; agent and edit with your own key need a paid plan",
    unmanaged: ["Tab completion and Cursor's own models", "Requests are sent from Cursor's servers, so the gateway must be reachable from the internet"],
    limitations: [
      "Cursor's forum reports Agent mode sending Responses-format requests to custom base URLs",
      "The 'use my API key' toggle has been reported to switch off silently, sending traffic to Cursor's billing",
    ],
  },
]

export const TOOL_IDS = TOOLS.map((tool) => tool.id)

export function toolByID(id: string): ToolProfile | undefined {
  return TOOLS.find((tool) => tool.id === id)
}

/** Version from a gateway User-Agent for tools that identify themselves; undefined when not recognised. */
export function toolVersionFromUserAgent(id: string, userAgent: string | undefined) {
  if (!userAgent) return undefined
  return toolByID(id)?.userAgent?.exec(userAgent)?.[1]
}
