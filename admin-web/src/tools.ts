/** Display labels for catalog fields served by /api/tools (the catalog itself lives in catalog/tools.ts). */
export const formLabel: Record<string, string> = { cli: "命令行", "ide-extension": "IDE 插件", ide: "IDE", desktop: "桌面应用" }

export const protocolLabel: Record<string, string> = {
  "openai-chat": "OpenAI Chat Completions",
  "anthropic-messages": "Anthropic Messages",
  "openai-responses": "OpenAI Responses",
  gemini: "Gemini 原生 API",
}

export const deliveryLabel: Record<string, string> = {
  "launch-env": "Launcher 启动时注入短期凭证",
  "opencode-login": "opencode auth login 登录",
  "ide-key": "在工具设置中填写 Saorsa Key",
}

/** Fills a route setting template with this console's origin and the chosen values. */
export function fillSetting(value: string, values: { origin: string; model?: string; key?: string }) {
  return value
    .replaceAll("{origin}", values.origin)
    .replaceAll("{model}", values.model ?? "<模型别名>")
    .replaceAll("{token}", "<由 Launcher 注入>")
    .replaceAll("{ide-key}", values.key ?? "<你的 Saorsa Key>")
}
