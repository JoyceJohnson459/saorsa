import type { Usage } from "./pricing.js"
import type { ChatMessage } from "./risk.js"

/**
 * Everything that differs between upstream wire protocols. The gateway pipeline (auth, budgets, retries,
 * ledger) is shared; an adapter only reads the request, shapes the upstream call, reads usage and formats
 * errors. Each adapter passes its own protocol through to an upstream that speaks it natively; no adapter
 * translates one protocol into another.
 */
export interface StreamState {
  usage: Usage | undefined
  /** Whether `usage` is the provider's final count. Anthropic's message_start usage is only preliminary. */
  usageFinal: boolean
  upstreamID: string | undefined
  outputChars: number
}

export type ProtocolID = "openai-chat" | "anthropic-messages" | "openai-responses" | "gemini"

/** What a request asks of the model, checked against the model's declared capabilities. */
export interface Features {
  tools: boolean
  images: boolean
  structuredOutput: boolean
}

export interface ProtocolAdapter {
  id: ProtocolID
  /** Validates the client body and returns the requested model alias and whether it streams. */
  read(body: Record<string, unknown>, route: { model?: string; stream?: boolean }): { model: string; stream: boolean }
  /** Conversation normalized to {role, content} for secret scanning and relevance hints. */
  messages(body: Record<string, unknown>): ChatMessage[]
  features(body: Record<string, unknown>): Features
  requestedMaxOutput(body: Record<string, unknown>): number | undefined
  /** Upstream path appended to the provider base URL. */
  upstreamPath(upstreamModel: string, stream: boolean): string
  upstreamHeaders(apiKey: string, client: Headers, stream: boolean): Record<string, string>
  prepareBody(body: Record<string, unknown>, upstreamModel: string, maxOutput: number, stream: boolean): Record<string, unknown>
  /** Rewrites a non-streamed response for the client (e.g. report the alias instead of the upstream model). */
  clientResponse(body: Record<string, unknown>, alias: string): Record<string, unknown>
  readUsage(body: Record<string, unknown>): Usage | undefined
  outputChars(body: Record<string, unknown>): number
  /** Applies one parsed SSE `data:` payload to the running stream state. */
  streamEvent(state: StreamState, data: Record<string, unknown>): void
  /** True when the SSE `data:` line is the protocol's explicit terminator rather than JSON. */
  isTerminator(data: string): boolean
  errorBody(status: number, code: string, message: string): Record<string, unknown>
  streamError(message: string): string
}

const jsonHeaders = (stream: boolean) => ({ "content-type": "application/json", accept: stream ? "text/event-stream" : "application/json" })

export const OpenAIChat: ProtocolAdapter = {
  id: "openai-chat",
  read: (body) => {
    requireModel(body)
    if (!Array.isArray(body.messages)) throw invalid("messages must be an array")
    return { model: body.model as string, stream: body.stream === true }
  },
  messages: (body) => (Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : []),
  features: (body) => ({
    tools: nonEmpty(body.tools) || nonEmpty(body.functions),
    images: hasPart(body.messages, (part) => part.type === "image_url" || part.type === "input_image"),
    structuredOutput: isRecord(body.response_format) && body.response_format.type === "json_schema",
  }),
  requestedMaxOutput: (body) => positive(body.max_completion_tokens) ?? positive(body.max_tokens),
  upstreamPath: () => "/chat/completions",
  upstreamHeaders: (apiKey, _client, stream) => ({ authorization: `Bearer ${apiKey}`, ...jsonHeaders(stream) }),
  prepareBody: (body, upstreamModel, maxOutput, stream) => ({
    ...body,
    model: upstreamModel,
    ...(typeof body.max_completion_tokens === "number" ? { max_completion_tokens: maxOutput } : { max_tokens: maxOutput }),
    // Usage in the final chunk is what makes streamed requests billable exactly.
    ...(stream ? { stream_options: { ...(isRecord(body.stream_options) ? body.stream_options : {}), include_usage: true } } : {}),
  }),
  clientResponse: (body, alias) => ({ ...body, model: alias }),
  readUsage: (body) => openAIUsage(body.usage),
  outputChars: (body) => JSON.stringify(body.choices ?? "").length,
  streamEvent: (state, chunk) => {
    if (typeof chunk.id === "string") state.upstreamID ??= chunk.id
    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : [])
      state.outputChars += JSON.stringify(isRecord(choice) ? (choice.delta ?? "") : "").length
    const usage = openAIUsage(chunk.usage)
    if (!usage) return
    state.usage = usage
    state.usageFinal = true
  },
  isTerminator: (data) => data === "[DONE]",
  errorBody: (status, code, message) => ({
    error: {
      message,
      type: status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : "invalid_request_error",
      code,
    },
  }),
  streamError: (message) => `data: ${JSON.stringify({ error: { message, type: "server_error", code: "stream_interrupted" } })}\n\n`,
}

export const AnthropicMessages: ProtocolAdapter = {
  id: "anthropic-messages",
  read: (body) => {
    requireModel(body)
    if (!Array.isArray(body.messages)) throw invalid("messages must be an array")
    return { model: body.model as string, stream: body.stream === true }
  },
  messages: (body) => [
    ...(body.system === undefined ? [] : [{ role: "system", content: body.system }]),
    ...(Array.isArray(body.messages) ? (body.messages as ChatMessage[]) : []),
  ],
  features: (body) => ({
    tools: nonEmpty(body.tools),
    images: hasPart(body.messages, (part) => part.type === "image"),
    structuredOutput: isRecord(body.output_config) && body.output_config.format !== undefined,
  }),
  requestedMaxOutput: (body) => positive(body.max_tokens),
  upstreamPath: () => "/messages",
  upstreamHeaders: (apiKey, client, stream) => ({
    "x-api-key": apiKey,
    ...jsonHeaders(stream),
    "anthropic-version": client.get("anthropic-version") ?? "2023-06-01",
    // Beta flags change request semantics (thinking, caching, tools), so they must reach the provider verbatim.
    ...(client.get("anthropic-beta") ? { "anthropic-beta": client.get("anthropic-beta")! } : {}),
  }),
  // Anthropic requires max_tokens; the gateway always sets it so the budget reservation is a true ceiling.
  prepareBody: (body, upstreamModel, maxOutput) => ({ ...body, model: upstreamModel, max_tokens: maxOutput }),
  clientResponse: (body, alias) => ({ ...body, model: alias }),
  readUsage: (body) => anthropicUsage(isRecord(body.usage) ? body.usage : undefined, undefined),
  outputChars: (body) => JSON.stringify(body.content ?? "").length,
  streamEvent: (state, event) => {
    if (event.type === "message_start" && isRecord(event.message)) {
      if (typeof event.message.id === "string") state.upstreamID ??= event.message.id
      state.usage = anthropicUsage(isRecord(event.message.usage) ? event.message.usage : undefined, state.usage)
      return
    }
    if (event.type === "message_delta") {
      if (!isRecord(event.usage)) return
      state.usage = anthropicUsage(event.usage, state.usage)
      state.usageFinal = state.usage !== undefined
      return
    }
    if (event.type === "content_block_delta" || event.type === "content_block_start")
      state.outputChars += JSON.stringify(event.delta ?? event.content_block ?? "").length
  },
  isTerminator: () => false,
  errorBody: (status, code, message) => ({
    type: "error",
    error: {
      type:
        status === 429
          ? "rate_limit_error"
          : status === 401
            ? "authentication_error"
            : status === 403 || status === 402
              ? "permission_error"
              : status === 404
                ? "not_found_error"
                : status >= 500
                  ? "api_error"
                  : "invalid_request_error",
      message: `${message} [${code}]`,
    },
  }),
  streamError: (message) => `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message } })}\n\n`,
}

/**
 * OpenAI Responses API (Codex CLI). Usage arrives in the final `response.completed` (or `response.incomplete`
 * / `response.failed`) event; anything earlier is not a final count.
 */
export const OpenAIResponses: ProtocolAdapter = {
  id: "openai-responses",
  read: (body) => {
    requireModel(body)
    if (typeof body.input !== "string" && !Array.isArray(body.input)) throw invalid("input must be a string or an array of items")
    return { model: body.model as string, stream: body.stream === true }
  },
  messages: (body) => [
    ...(typeof body.instructions === "string" ? [{ role: "system", content: body.instructions }] : []),
    ...(typeof body.input === "string"
      ? [{ role: "user", content: body.input }]
      : (Array.isArray(body.input) ? body.input : []).filter(isRecord).map((item) =>
          item.type === "function_call_output" || item.type === "custom_tool_call_output"
            ? { role: "tool", content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") }
            : item.type === "function_call"
              ? { role: "assistant", content: "" }
              : { role: typeof item.role === "string" ? item.role : "user", content: item.content },
        )),
  ],
  features: (body) => ({
    tools: nonEmpty(body.tools),
    images: hasPart(Array.isArray(body.input) ? body.input : [], (part) => part.type === "input_image"),
    structuredOutput: isRecord(body.text) && isRecord(body.text.format) && body.text.format.type === "json_schema",
  }),
  requestedMaxOutput: (body) => positive(body.max_output_tokens),
  upstreamPath: () => "/responses",
  upstreamHeaders: (apiKey, _client, stream) => ({ authorization: `Bearer ${apiKey}`, ...jsonHeaders(stream) }),
  prepareBody: (body, upstreamModel, maxOutput) => ({ ...body, model: upstreamModel, max_output_tokens: maxOutput }),
  clientResponse: (body, alias) => ({ ...body, model: alias }),
  readUsage: (body) => openAIUsage(body.usage),
  outputChars: (body) => JSON.stringify(body.output ?? "").length,
  streamEvent: (state, event) => {
    const response = isRecord(event.response) ? event.response : undefined
    if (typeof response?.id === "string") state.upstreamID ??= response.id
    if (typeof event.delta === "string") state.outputChars += event.delta.length
    if (event.type !== "response.completed" && event.type !== "response.incomplete" && event.type !== "response.failed") return
    const usage = openAIUsage(response?.usage)
    if (!usage) return
    state.usage = usage
    state.usageFinal = true
  },
  isTerminator: (data) => data === "[DONE]",
  errorBody: (status, code, message) => ({
    error: {
      message,
      type: status === 429 ? "rate_limit_error" : status === 401 ? "authentication_error" : status >= 500 ? "server_error" : "invalid_request_error",
      code,
    },
  }),
  streamError: (message) =>
    `event: error\ndata: ${JSON.stringify({ type: "error", code: "stream_interrupted", message, param: null })}\n\n`,
}

/**
 * Gemini native API (Gemini CLI). The model is in the URL (`models/{model}:generateContent`), streaming is a
 * different method (`:streamGenerateContent?alt=sse`), and every chunk repeats the cumulative usageMetadata;
 * the count is final once a candidate carries a finishReason.
 */
export const GeminiNative: ProtocolAdapter = {
  id: "gemini",
  read: (body, route) => {
    if (!route.model) throw invalid("model is required in the request path")
    if (!Array.isArray(body.contents)) throw invalid("contents must be an array")
    return { model: route.model, stream: route.stream === true }
  },
  messages: (body) => [
    ...(isRecord(body.systemInstruction) ? [{ role: "system", content: body.systemInstruction.parts }] : []),
    ...(Array.isArray(body.contents) ? body.contents : []).filter(isRecord).map((content) => ({
      // functionResponse parts carry tool output (file contents the agent read), so they are scanned too.
      role: content.role === "model" ? "assistant" : Array.isArray(content.parts) && content.parts.some((part) => isRecord(part) && part.functionResponse) ? "tool" : "user",
      content: (Array.isArray(content.parts) ? content.parts : []).filter(isRecord).map((part) =>
        typeof part.text === "string"
          ? { type: "text", text: part.text }
          : isRecord(part.functionResponse)
            ? { type: "text", text: JSON.stringify(part.functionResponse.response ?? "") }
            : {},
      ),
    })),
  ],
  features: (body) => ({
    tools: (Array.isArray(body.tools) ? body.tools : []).some((tool) => isRecord(tool) && nonEmpty(tool.functionDeclarations)),
    images: (Array.isArray(body.contents) ? body.contents : []).some(
      (content) =>
        isRecord(content) &&
        Array.isArray(content.parts) &&
        content.parts.some((part) => isRecord(part) && isRecord(part.inlineData) && String(part.inlineData.mimeType ?? "").startsWith("image/")),
    ),
    structuredOutput: isRecord(body.generationConfig) && (body.generationConfig.responseSchema !== undefined || body.generationConfig.responseJsonSchema !== undefined),
  }),
  requestedMaxOutput: (body) => (isRecord(body.generationConfig) ? positive(body.generationConfig.maxOutputTokens) : undefined),
  upstreamPath: (upstreamModel, stream) => `/models/${encodeURIComponent(upstreamModel)}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`,
  upstreamHeaders: (apiKey, _client, stream) => ({ "x-goog-api-key": apiKey, ...jsonHeaders(stream) }),
  prepareBody: (body, _upstreamModel, maxOutput) => ({
    ...body,
    generationConfig: { ...(isRecord(body.generationConfig) ? body.generationConfig : {}), maxOutputTokens: maxOutput },
  }),
  clientResponse: (body) => body,
  readUsage: (body) => geminiUsage(body.usageMetadata),
  outputChars: (body) => JSON.stringify(body.candidates ?? "").length,
  streamEvent: (state, chunk) => {
    if (typeof chunk.responseId === "string") state.upstreamID ??= chunk.responseId
    const candidates = Array.isArray(chunk.candidates) ? chunk.candidates.filter(isRecord) : []
    for (const candidate of candidates) state.outputChars += JSON.stringify(candidate.content ?? "").length
    const usage = geminiUsage(chunk.usageMetadata)
    if (usage) state.usage = usage
    if (usage && candidates.some((candidate) => typeof candidate.finishReason === "string")) state.usageFinal = true
  },
  isTerminator: () => false,
  errorBody: (status, code, message) => ({
    error: {
      code: status,
      message: `${message} [${code}]`,
      status:
        status === 429
          ? "RESOURCE_EXHAUSTED"
          : status === 401
            ? "UNAUTHENTICATED"
            : status === 403 || status === 402
              ? "PERMISSION_DENIED"
              : status === 404
                ? "NOT_FOUND"
                : status >= 500
                  ? "UNAVAILABLE"
                  : "INVALID_ARGUMENT",
    },
  }),
  streamError: (message) => `data: ${JSON.stringify({ error: { code: 500, message, status: "UNAVAILABLE" } })}\n\n`,
}

export const PROTOCOLS = {
  "openai-chat": OpenAIChat,
  "anthropic-messages": AnthropicMessages,
  "openai-responses": OpenAIResponses,
  gemini: GeminiNative,
} as const

function openAIUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined
  const prompt = Number(value.prompt_tokens ?? value.input_tokens)
  const completion = Number(value.completion_tokens ?? value.output_tokens)
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return undefined
  // Chat Completions nests details under prompt_/completion_tokens_details, Responses under input_/output_tokens_details.
  const promptDetails = isRecord(value.prompt_tokens_details) ? value.prompt_tokens_details : isRecord(value.input_tokens_details) ? value.input_tokens_details : {}
  const completionDetails = isRecord(value.completion_tokens_details)
    ? value.completion_tokens_details
    : isRecord(value.output_tokens_details)
      ? value.output_tokens_details
      : {}
  return {
    input: prompt,
    output: completion,
    cacheRead: Number(promptDetails.cached_tokens ?? value.prompt_cache_hit_tokens ?? value.cached_tokens ?? 0) || 0,
    cacheWrite: Number(promptDetails.cache_write_tokens ?? value.cache_created_input_tokens ?? 0) || 0,
    reasoning: Number(completionDetails.reasoning_tokens ?? 0) || 0,
  }
}

/**
 * Gemini's promptTokenCount includes cached tokens; candidatesTokenCount excludes thinking, which is billed as
 * output. Normalized to the OpenAI convention billableLines() expects (output includes reasoning).
 */
export function geminiUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined
  const prompt = Number(value.promptTokenCount)
  if (!Number.isFinite(prompt)) return undefined
  const candidates = Number(value.candidatesTokenCount ?? 0) || 0
  const thoughts = Number(value.thoughtsTokenCount ?? 0) || 0
  return {
    input: prompt + (Number(value.toolUsePromptTokenCount ?? 0) || 0),
    output: candidates + thoughts,
    cacheRead: Number(value.cachedContentTokenCount ?? 0) || 0,
    cacheWrite: 0,
    reasoning: thoughts,
  }
}

/**
 * Anthropic reports input_tokens EXCLUDING cache reads and writes, and repeats/updates usage across
 * message_start and message_delta. Fields merge last-write-wins, and the result is normalized to the
 * OpenAI convention (input includes cache) that billableLines() expects.
 */
export function anthropicUsage(value: Record<string, unknown> | undefined, previous: Usage | undefined): Usage | undefined {
  if (!value) return previous
  const number = (key: string) => (typeof value[key] === "number" ? (value[key] as number) : undefined)
  const prior = previous
    ? { uncached: previous.input - previous.cacheRead - previous.cacheWrite, output: previous.output, read: previous.cacheRead, write: previous.cacheWrite }
    : undefined
  const uncached = number("input_tokens") ?? prior?.uncached
  const output = number("output_tokens") ?? prior?.output
  const read = number("cache_read_input_tokens") ?? prior?.read ?? 0
  const write = number("cache_creation_input_tokens") ?? prior?.write ?? 0
  if (uncached === undefined || output === undefined) return previous
  return { input: uncached + read + write, output, cacheRead: read, cacheWrite: write, reasoning: 0 }
}

/** Raised for malformed client bodies; the gateway turns it into a protocol-shaped 400. */
export class InvalidRequest extends Error {}

const invalid = (message: string) => new InvalidRequest(message)

function requireModel(body: Record<string, unknown>) {
  if (typeof body.model !== "string" || !body.model) throw invalid("model is required")
}

const positive = (value: unknown) => (typeof value === "number" && value > 0 ? Math.floor(value) : undefined)

const nonEmpty = (value: unknown) => Array.isArray(value) && value.length > 0

function hasPart(messages: unknown, match: (part: Record<string, unknown>) => boolean) {
  return (Array.isArray(messages) ? messages : []).some(
    (message) => isRecord(message) && Array.isArray(message.content) && message.content.some((part) => isRecord(part) && match(part)),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
