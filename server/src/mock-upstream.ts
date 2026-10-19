/**
 * MOCK UPSTREAM — TEST ENVIRONMENT ONLY.
 * A fake provider speaking OpenAI Chat Completions, OpenAI Responses, Anthropic Messages and the Gemini native
 * API, for automated tests and local tool verification without a real API key.
 * Usage reported here is synthetic. It is never used unless an admin registers its URL as a provider,
 * which the gateway only permits when SAORSA_ALLOW_PRIVATE_UPSTREAMS=true.
 */
export const MOCK_KEY = "mock-upstream-test-key-not-a-secret"

export interface MockControl {
  /** Next N responses use this status (e.g. 429/500/401). */
  failNext?: { status: number; count: number; code?: string; message?: string; retryAfter?: number }
  /** Stop sending (but keep the connection open) after N chunks, to exercise idle timeouts. */
  stallAfter?: number
  /** Replace the assistant text (OpenAI path), e.g. a JSON verdict for the audit classifier. */
  replyText?: string
  /** Every chat request body received, in order. */
  bodies: Array<Record<string, unknown>>
  /** Request paths received, in order (all protocols). */
  paths: string[]
  /** Omit usage from responses to exercise the estimated-billing path. */
  omitUsage?: boolean
  /** Break the stream after N chunks. */
  breakStreamAfter?: number
  /** Delay before responding, in ms. */
  delayMs?: number
  /** Anthropic path: cache tokens to report (input_tokens then excludes them, as the real API does). */
  anthropicCache?: { read: number; write: number }
  /** Anthropic path: answer the next turn that has tools with a tool_use block for this tool. */
  anthropicToolUse?: { name: string; input: Record<string, unknown> } | { auto: true; file: string }
  lastHeaders?: Record<string, string>
  /** Both protocols: call the client's read tool for this many consecutive rounds before answering. */
  toolRounds?: { file: string; rounds: number }
  calls: number
  lastBody?: Record<string, unknown>
}

export function startMockUpstream(port = 0) {
  const control: MockControl = { calls: 0, bodies: [], paths: [] }
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url)
      control.paths.push(`${request.method} ${url.pathname}`)
      const geminiTarget = /\/models\/([^/:]+):(\w+)$/.exec(url.pathname)
      if (geminiTarget) return gemini(request, url, decodeURIComponent(geminiTarget[1]!), geminiTarget[2]!, control)
      if (url.pathname.endsWith("/messages/count_tokens")) return anthropicCount(request, control)
      if (url.pathname.endsWith("/messages")) return anthropic(request, control)
      if (url.pathname.endsWith("/responses")) return responses(request, control)
      if (url.pathname.endsWith("/models") && request.method === "GET" && request.headers.get("x-api-key") === MOCK_KEY)
        return Response.json({ data: [{ id: "mock-claude", type: "model" }] })
      if (request.headers.get("authorization") !== `Bearer ${MOCK_KEY}`)
        return Response.json({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }, { status: 401 })
      if (url.pathname.endsWith("/models") && request.method === "GET")
        return Response.json({ object: "list", data: [{ id: "mock-chat", object: "model" }] })
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      control.calls++
      const body = (await request.json()) as Record<string, unknown>
      control.lastBody = body
      control.bodies.push(body)
      if (control.delayMs) await Bun.sleep(control.delayMs)
      if (control.failNext && control.failNext.count > 0) {
        const failure = control.failNext
        failure.count--
        return Response.json(
          { error: { message: failure.message ?? `mock failure ${failure.status}`, ...(failure.code ? { code: failure.code, type: failure.code } : {}) } },
          { status: failure.status, headers: failure.retryAfter ? { "retry-after": String(failure.retryAfter) } : {} },
        )
      }
      const messages = (body.messages as Array<{ role?: string; content?: unknown }>) ?? []
      const promptTokens = Math.max(1, Math.ceil(JSON.stringify(messages).length / 4))
      const toolResults = messages.filter((message) => message.role === "tool").length
      const readTool = control.toolRounds && toolResults < control.toolRounds.rounds ? findReadTool(body.tools, "openai") : undefined
      if (readTool && control.toolRounds) {
        const args = JSON.stringify(readTool.args(control.toolRounds.file))
        const callID = `call_mock_${control.calls}`
        console.log(`[MOCK UPSTREAM] openai tool_call ${readTool.name} round ${toolResults + 1}/${control.toolRounds.rounds}`)
        const usage = { prompt_tokens: promptTokens, completion_tokens: 15, total_tokens: promptTokens + 15 }
        const id = `chatcmpl-mock-${control.calls}`
        if (body.stream !== true)
          return Response.json({
            id,
            object: "chat.completion",
            model: body.model,
            choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: callID, type: "function", function: { name: readTool.name, arguments: args } }] }, finish_reason: "tool_calls" }],
            usage,
          })
        const encoder = new TextEncoder()
        const chunk = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`)
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(chunk({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: callID, type: "function", function: { name: readTool.name, arguments: "" } }] }, finish_reason: null }] }))
              controller.enqueue(chunk({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] }))
              controller.enqueue(chunk({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }))
              controller.enqueue(chunk({ id, object: "chat.completion.chunk", model: body.model, choices: [], usage }))
              controller.enqueue(encoder.encode("data: [DONE]\n\n"))
              controller.close()
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      const lastTool = messages.findLast((message) => message.role === "tool")
      const reply =
        control.replyText ??
        (lastTool
          ? `The tool ran successfully (mock upstream, synthetic data). Tool output: ${snippet(lastTool.content)}`
          : "Hello from the mock upstream. This response is synthetic test data.")
      const words = reply.split(" ")
      const usage = { prompt_tokens: promptTokens, completion_tokens: words.length, total_tokens: promptTokens + words.length, prompt_tokens_details: { cached_tokens: 0 } }
      const id = `chatcmpl-mock-${control.calls}`
      if (body.stream !== true)
        return Response.json({
          id,
          object: "chat.completion",
          model: body.model,
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          ...(control.omitUsage ? {} : { usage }),
        })
      const includeUsage = (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage === true
      const encoder = new TextEncoder()
      const breakAfter = control.breakStreamAfter
      const stallAfter = control.stallAfter
      const stream = new ReadableStream({
        async start(controller) {
          const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`))
          for (const [index, word] of words.entries()) {
            if (stallAfter !== undefined && index >= stallAfter) return
            if (breakAfter !== undefined && index >= breakAfter) {
              controller.error(new Error("mock stream broken"))
              return
            }
            send({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { content: (index ? " " : "") + word }, finish_reason: null }] })
            await Bun.sleep(2)
          }
          send({ id, object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })
          if (includeUsage && !control.omitUsage) send({ id, object: "chat.completion.chunk", model: body.model, choices: [], usage })
          controller.enqueue(encoder.encode("data: [DONE]\n\n"))
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { server, control, url: `http://127.0.0.1:${server.port}/v1` }
}

/** Anthropic Messages API imitation (TEST ONLY): same auth, headers, usage and SSE event shapes. */
async function anthropic(request: Request, control: MockControl) {
  control.lastHeaders = Object.fromEntries(request.headers.entries())
  const error = (status: number, type: string, message: string) =>
    Response.json({ type: "error", error: { type, message } }, { status })
  if (request.headers.get("x-api-key") !== MOCK_KEY) return error(401, "authentication_error", "invalid x-api-key")
  if (!request.headers.get("anthropic-version")) return error(400, "invalid_request_error", "anthropic-version header is required")
  control.calls++
  const body = (await request.json()) as Record<string, unknown>
  control.lastBody = body
  if (typeof body.max_tokens !== "number") return error(400, "invalid_request_error", "max_tokens: Field required")
  if (control.failNext && control.failNext.count > 0) {
    control.failNext.count--
    return error(control.failNext.status, control.failNext.status === 529 ? "overloaded_error" : "api_error", `mock failure ${control.failNext.status}`)
  }
  const messages = (body.messages as Array<{ role: string; content: unknown }>) ?? []
  const last = messages.at(-1)
  // Clients may append reminder text next to tool results, so look at everything after the last assistant turn.
  const trailing = messages.slice(messages.findLastIndex((message) => message.role === "assistant") + 1)
  const toolResult = trailing.flatMap((message) => (Array.isArray(message.content) ? message.content : [])).find((part: any) => part?.type === "tool_result") as
    | { content?: unknown }
    | undefined
  const answeringTool = toolResult !== undefined || (Array.isArray(last?.content) && last.content.some((part: any) => part?.type === "tool_result"))
  const toolResults = messages.filter((message) => Array.isArray(message.content) && message.content.some((part: any) => part?.type === "tool_result")).length
  const roundTool =
    control.toolRounds && toolResults < control.toolRounds.rounds ? findReadTool(body.tools, "anthropic") : undefined
  const tool = roundTool
    ? { name: roundTool.name, input: roundTool.args(control.toolRounds!.file) }
    : Array.isArray(body.tools) && body.tools.length && !answeringTool
      ? pickTool(control, body.tools)
      : undefined
  if (roundTool) console.log(`[MOCK UPSTREAM] anthropic tool_use ${roundTool.name} round ${toolResults + 1}/${control.toolRounds!.rounds}`)
  const cache = control.anthropicCache ?? { read: 0, write: 0 }
  const total = Math.max(1, Math.ceil(JSON.stringify(messages).length / 4))
  const inputTokens = Math.max(1, total - cache.read - cache.write)
  const reply = answeringTool
    ? `The tool ran successfully (mock Anthropic upstream, synthetic data). Tool output: ${snippet(toolResult?.content)}`
    : "Hello from the mock Anthropic upstream. Synthetic test data."
  const words = reply.split(" ")
  const id = `msg_mock_${control.calls}`
  const usage = { input_tokens: inputTokens, output_tokens: tool ? 12 : words.length, cache_read_input_tokens: cache.read, cache_creation_input_tokens: cache.write }
  const content = tool
    ? [{ type: "tool_use", id: `toolu_mock_${control.calls}`, name: tool.name, input: tool.input }]
    : [{ type: "text", text: reply }]
  if (body.stream !== true)
    return Response.json({ id, type: "message", role: "assistant", model: body.model, content, stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null, ...(control.omitUsage ? {} : { usage }) })
  const encoder = new TextEncoder()
  const breakAfter = control.breakStreamAfter
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`))
      send("message_start", { message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: control.omitUsage ? undefined : { ...usage, output_tokens: 1 } } })
      if (tool) {
        send("content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_mock_${control.calls}`, name: tool.name, input: {} } })
        send("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } })
      } else {
        send("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
        for (const [index, word] of words.entries()) {
          if (breakAfter !== undefined && index >= breakAfter) {
            controller.error(new Error("mock stream broken"))
            return
          }
          send("content_block_delta", { index: 0, delta: { type: "text_delta", text: (index ? " " : "") + word } })
          await Bun.sleep(2)
        }
      }
      send("content_block_stop", { index: 0 })
      send("message_delta", { delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, ...(control.omitUsage ? {} : { usage: { output_tokens: usage.output_tokens } }) })
      send("message_stop", {})
      controller.close()
    },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

/** OpenAI Responses API imitation (TEST ONLY): output items, SSE event sequence and final usage as documented. */
async function responses(request: Request, control: MockControl) {
  if (request.headers.get("authorization") !== `Bearer ${MOCK_KEY}`)
    return Response.json({ error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }, { status: 401 })
  control.calls++
  const body = (await request.json()) as Record<string, unknown>
  control.lastBody = body
  control.lastHeaders = Object.fromEntries(request.headers.entries())
  if (control.failNext && control.failNext.count > 0) {
    const failure = control.failNext
    failure.count--
    return Response.json({ error: { message: failure.message ?? `mock failure ${failure.status}`, type: "server_error", code: failure.code ?? null } }, { status: failure.status })
  }
  const input = Array.isArray(body.input) ? (body.input as Array<Record<string, unknown>>) : []
  const toolResults = input.filter((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output").length
  const tool = control.toolRounds && toolResults < control.toolRounds.rounds ? findReadTool(body.tools, "responses") : undefined
  const id = `resp_mock_${control.calls}`
  const inputTokens = Math.max(1, Math.ceil(JSON.stringify(body.input ?? "").length / 4))
  const lastOutput = input.findLast((item) => item.type === "function_call_output" || item.type === "custom_tool_call_output")
  const reply = toolResults
    ? `The tool ran successfully (mock Responses upstream, synthetic data). Tool output: ${snippet(lastOutput?.output)}`
    : "Hello from the mock Responses upstream. Synthetic test data."
  const usage = { input_tokens: inputTokens, input_tokens_details: { cached_tokens: 0 }, output_tokens: tool ? 14 : reply.split(" ").length, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 0 }
  usage.total_tokens = usage.input_tokens + usage.output_tokens
  const args = tool ? JSON.stringify(tool.args(control.toolRounds!.file)) : ""
  if (tool) console.log(`[MOCK UPSTREAM] responses function_call ${tool.name} round ${toolResults + 1}/${control.toolRounds!.rounds}`)
  const item = tool
    ? { type: "function_call", id: `fc_mock_${control.calls}`, call_id: `call_mock_${control.calls}`, name: tool.name, arguments: args, status: "completed" }
    : { type: "message", id: `msg_mock_${control.calls}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: reply, annotations: [] }] }
  const response = (status: string, output: unknown[]) => ({ id, object: "response", created_at: Math.floor(Date.now() / 1000), status, model: body.model, output, ...(status === "completed" && !control.omitUsage ? { usage } : {}) })
  if (body.stream !== true) return Response.json(response("completed", [item]))
  const encoder = new TextEncoder()
  let sequence = 0
  const breakAfter = control.breakStreamAfter
  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (type: string, data: Record<string, unknown>) =>
          controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`))
        send("response.created", { response: response("in_progress", []) })
        send("response.in_progress", { response: response("in_progress", []) })
        if (item.type === "function_call") {
          send("response.output_item.added", { output_index: 0, item: { ...item, arguments: "", status: "in_progress" } })
          send("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: args })
          send("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: args })
        } else {
          send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } })
          send("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } })
          for (const [index, word] of reply.split(" ").entries()) {
            if (breakAfter !== undefined && index >= breakAfter) {
              controller.error(new Error("mock stream broken"))
              return
            }
            send("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: (index ? " " : "") + word })
            await Bun.sleep(2)
          }
          send("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: reply })
          send("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: reply, annotations: [] } })
        }
        send("response.output_item.done", { output_index: 0, item })
        send("response.completed", { response: response("completed", [item]) })
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

/** Gemini native API imitation (TEST ONLY): generateContent, streamGenerateContent?alt=sse and countTokens. */
async function gemini(request: Request, url: URL, model: string, method: string, control: MockControl) {
  const error = (status: number, state: string, message: string) => Response.json({ error: { code: status, message, status: state } }, { status })
  if ((request.headers.get("x-goog-api-key") ?? url.searchParams.get("key")) !== MOCK_KEY) return error(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.")
  const body = (await request.json()) as Record<string, unknown>
  const contents = Array.isArray(body.contents) ? (body.contents as Array<{ role?: string; parts?: Array<Record<string, unknown>> }>) : []
  const promptTokens = Math.max(1, Math.ceil(JSON.stringify(contents).length / 4))
  if (method === "countTokens") return Response.json({ totalTokens: promptTokens })
  if (method !== "generateContent" && method !== "streamGenerateContent") return error(404, "NOT_FOUND", `method ${method} not found`)
  control.calls++
  control.lastBody = body
  control.lastHeaders = Object.fromEntries(request.headers.entries())
  if (control.failNext && control.failNext.count > 0) {
    const failure = control.failNext
    failure.count--
    return error(failure.status, failure.status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE", `mock failure ${failure.status}`)
  }
  const toolResults = contents.filter((content) => (content.parts ?? []).some((part) => part.functionResponse)).length
  const tool = control.toolRounds && toolResults < control.toolRounds.rounds ? findReadTool(body.tools, "gemini") : undefined
  if (tool) console.log(`[MOCK UPSTREAM] gemini functionCall ${tool.name} round ${toolResults + 1}/${control.toolRounds!.rounds}`)
  const lastResponse = contents.flatMap((content) => content.parts ?? []).findLast((part) => part.functionResponse)?.functionResponse
  const reply = toolResults
    ? `The tool ran successfully (mock Gemini upstream, synthetic data). Tool output: ${snippet(lastResponse)}`
    : "Hello from the mock Gemini upstream. Synthetic test data."
  const words = reply.split(" ")
  const usageMetadata = { promptTokenCount: promptTokens, candidatesTokenCount: tool ? 9 : words.length, totalTokenCount: promptTokens + (tool ? 9 : words.length) }
  const responseId = `gem_mock_${control.calls}`
  const final = (parts: unknown[]) => ({
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
    ...(control.omitUsage ? {} : { usageMetadata }),
    modelVersion: model,
    responseId,
  })
  const toolParts = tool ? [{ functionCall: { name: tool.name, args: tool.args(control.toolRounds!.file) } }] : undefined
  if (method === "generateContent") return Response.json(final(toolParts ?? [{ text: reply }]))
  if (url.searchParams.get("alt") !== "sse") return error(400, "INVALID_ARGUMENT", "mock supports streamGenerateContent with alt=sse only")
  const encoder = new TextEncoder()
  const breakAfter = control.breakStreamAfter
  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (value: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\r\n\r\n`))
        if (toolParts) send(final(toolParts))
        else {
          for (const [index, word] of words.entries()) {
            if (breakAfter !== undefined && index >= breakAfter) {
              controller.error(new Error("mock stream broken"))
              return
            }
            const last = index === words.length - 1
            const parts = [{ text: (index ? " " : "") + word }]
            // Like the real API, intermediate chunks carry running usage; only the last has a finishReason.
            send(last ? final(parts) : { candidates: [{ content: { role: "model", parts }, index: 0 }], usageMetadata: { promptTokenCount: promptTokens, candidatesTokenCount: index + 1, totalTokenCount: promptTokens + index + 1 }, modelVersion: model, responseId })
            await Bun.sleep(2)
          }
        }
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function anthropicCount(request: Request, control: MockControl) {
  if (request.headers.get("x-api-key") !== MOCK_KEY) return Response.json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, { status: 401 })
  const body = (await request.json()) as Record<string, unknown>
  control.lastHeaders = Object.fromEntries(request.headers.entries())
  return Response.json({ input_tokens: Math.max(1, Math.ceil(JSON.stringify(body.messages ?? []).length / 4)) })
}

/**
 * Finds a tool the client offers for reading a file (or, failing that, a shell tool that can `cat` it) and builds
 * its arguments. Covers OpenAI Chat, Responses, Anthropic and Gemini tool list shapes, so each real CLI's own
 * read-only tool is exercised.
 */
function findReadTool(tools: unknown, protocol: "openai" | "anthropic" | "responses" | "gemini") {
  if (!Array.isArray(tools)) return undefined
  const normalized = tools.flatMap((tool: any): Array<{ name: string; schema: any }> => {
    if (protocol === "openai") return [{ name: tool?.function?.name, schema: tool?.function?.parameters }]
    if (protocol === "anthropic") return [{ name: tool?.name, schema: tool?.input_schema }]
    if (protocol === "responses") return tool?.type === "function" ? [{ name: tool.name, schema: tool.parameters }] : []
    return (tool?.functionDeclarations ?? []).map((declaration: any) => ({ name: declaration.name, schema: declaration.parameters ?? declaration.parametersJsonSchema }))
  }).filter((tool) => typeof tool.name === "string")
  const read =
    normalized.find((tool) => /^(read|read_file|readfile|view)$/i.test(tool.name)) ??
    normalized.find((tool) => /read/i.test(tool.name) && !/many|multi|dir|list/i.test(tool.name))
  if (read) {
    const required: string[] = Array.isArray(read.schema?.required) ? read.schema.required : []
    return { name: read.name, args: (file: string) => Object.fromEntries(required.map((key) => [key, /path|file/i.test(key) ? file : ""])) }
  }
  const shell = normalized.find((tool) => /^(shell|exec_command|run_shell_command|bash|shell_command)$/i.test(tool.name))
  if (!shell) return undefined
  const properties = shell.schema?.properties ?? {}
  return {
    name: shell.name,
    args: (file: string) =>
      properties.command?.type === "array"
        ? { command: ["cat", file] }
        : properties.cmd
          ? { cmd: `cat ${file}` }
          : { command: `cat ${file}` },
  }
}

/** "auto" picks a file-reading tool from the client's own tool list and fills its required path argument. */
function pickTool(control: MockControl, tools: unknown[]) {
  const setting = control.anthropicToolUse
  if (!setting) return undefined
  if (!("auto" in setting)) return setting
  const candidates = tools as Array<{ name: string; input_schema?: { properties?: Record<string, { type?: string }>; required?: string[] } }>
  const read = candidates.find((tool) => /^read$/i.test(tool.name)) ?? candidates.find((tool) => /read/i.test(tool.name))
  if (!read) return undefined
  const input = Object.fromEntries(
    (read.input_schema?.required ?? []).map((key) => [key, /path|file/i.test(key) ? setting.file : ""]),
  )
  console.log(`[MOCK UPSTREAM] tool_use ${read.name} ${JSON.stringify(input)}`)
  return { name: read.name, input }
}

/** First characters of a tool result, so a lab run can prove the tool's real output came back. */
function snippet(value: unknown) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "")
  return text.replace(/\s+/g, " ").trim().slice(0, 400)
}

if (import.meta.main) {
  const mock = startMockUpstream(Number(process.env.MOCK_UPSTREAM_PORT ?? 18080))
  if (process.env.MOCK_ANTHROPIC_TOOL_FILE) mock.control.anthropicToolUse = { auto: true, file: process.env.MOCK_ANTHROPIC_TOOL_FILE }
  if (process.env.MOCK_TOOL_FILE)
    mock.control.toolRounds = { file: process.env.MOCK_TOOL_FILE, rounds: Number(process.env.MOCK_TOOL_ROUNDS ?? 2) }
  console.log(`[MOCK UPSTREAM — test data only] ${mock.url}  key: ${MOCK_KEY}`)
}
