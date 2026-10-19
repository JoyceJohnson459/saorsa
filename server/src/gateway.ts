import type { Context, Hono } from "hono"
import { ApiError, type AppEnv, type Deps, type Principal } from "./context.js"
import { bearer, clientIP, endedReason, principalFromToken, touchClientSession } from "./auth.js"
import { reserve, release, settle, type CrossedThreshold } from "./budget.js"
import { billableLines, estimateCeiling, formatMoney, priceAt, type PriceVersion, type Usage } from "./pricing.js"
import { notify } from "./audit.js"
import {
  auditModelRelevance,
  isHumanPrompt,
  keywordRelevance,
  loadRules,
  messageText,
  recordRisk,
  scanSecrets,
  secretRiskEvents,
  type ChatMessage,
} from "./risk.js"
import { orgSettings } from "./settings.js"
import { redactSecrets } from "./redact.js"
import { InvalidRequest, PROTOCOLS, type Features, type ProtocolAdapter, type StreamState } from "./protocols.js"
import type { TokenTicket } from "./ratelimit.js"
import { toolByID, toolVersionFromUserAgent } from "../../catalog/tools.js"
import { claimKey, freeCredential, noFreeKey } from "./keys.js"

const MAX_BODY_BYTES = 20 * 1024 * 1024
const MAX_ATTEMPTS = 3
// 529 is Anthropic's "overloaded".
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529])

interface ResolvedModel {
  id: string
  alias: string
  upstreamModel: string
  providerID: string
  baseURL: string
  protocol: string
  defaultMaxOutput: number
  outputLimit: number | null
  capabilities: { tools: boolean; streaming: boolean; vision: boolean; structuredOutput: boolean }
  limits: {
    concurrency: number | null
    requestsPerMinute: number | null
    tokensPerMinute: number | null
    providerConcurrency: number | null
    providerRequestsPerMinute: number | null
  }
}

interface GatewayContext {
  deps: Deps
  protocol: ProtocolAdapter
  principal: Principal & { projectID: string; toolID: string }
  model: ResolvedModel
  price: PriceVersion
  requestUUID: string
  requestID: string
  requestBytes: number
  startedAt: Date
  tokenTicket: TokenTicket
  /** Set in exclusive key assignment: the key leased to this member for the model's provider. */
  leased?: Credential
  stream: boolean
}

type Credential = { id: string; ciphertext: Uint8Array; nonce: Uint8Array; key_version: number }

export function gatewayRoutes(app: Hono<AppEnv>) {
  app.get("/gateway/v1/models", async (c) => {
    const principal = await gatewayPrincipal(c)
    const models = await authorizedModels(c.get("deps"), principal.projectID, principal.toolID)
    return c.json({
      object: "list",
      data: models.map((model) => ({ id: model.alias, object: "model", created: 0, owned_by: "saorsa" })),
    })
  })

  // Anthropic-format model discovery (Claude Code with CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1).
  app.get("/gateway/anthropic/v1/models", async (c) => {
    const principal = await gatewayPrincipal(c)
    const models = (await authorizedModels(c.get("deps"), principal.projectID, principal.toolID)).filter((model) =>
      servesProtocol(model, "anthropic-messages"),
    )
    return c.json({
      data: models.map((model) => ({ type: "model", id: model.alias, display_name: model.display_name, created_at: "1970-01-01T00:00:00Z" })),
      has_more: false,
      first_id: models[0]?.alias ?? null,
      last_id: models.at(-1)?.alias ?? null,
    })
  })

  // Claude Code's best-effort connection-warming probe; it carries no credential and needs only a quick answer.
  // Hono answers HEAD with the GET route, so a HEAD-only route would never match.
  app.get("/gateway/anthropic/api/hello", (c) => c.body(null, 200))

  // Each wire protocol gets its own endpoint, in the form each tool's own SDK expects, so tools talk to it
  // unchanged: OpenAI-compatible clients → /gateway/v1, Anthropic clients → /gateway/anthropic,
  // Codex → /gateway/v1/responses, Gemini CLI → /gateway/gemini.
  const handle = (protocol: ProtocolAdapter, route: (c: Context<AppEnv>) => GatewayRoute = () => ({})) => async (c: Context<AppEnv>) => {
    try {
      const target = route(c)
      if (target.countTokens) return await countTokens(c, protocol, target)
      return await governedRequest(c, protocol, target)
    } catch (error) {
      if (error instanceof ApiError) return errorResponse(c, protocol, error)
      throw error
    }
  }
  app.post("/gateway/v1/chat/completions", handle(PROTOCOLS["openai-chat"]))
  app.post("/gateway/v1/responses", handle(PROTOCOLS["openai-responses"]))
  app.post("/gateway/anthropic/v1/messages", handle(PROTOCOLS["anthropic-messages"]))
  app.post("/gateway/anthropic/v1/messages/count_tokens", handle(PROTOCOLS["anthropic-messages"], () => ({ countTokens: true })))
  app.post(
    "/gateway/gemini/:version/models/:target",
    handle(PROTOCOLS.gemini, (c) => {
      const [model, method] = splitGeminiTarget(c.req.param("target"))
      if (method === "countTokens") return { model, countTokens: true }
      if (method !== "generateContent" && method !== "streamGenerateContent")
        throw new ApiError(404, "unsupported_method", `Gemini method ${method} is not served by the Saorsa gateway`, { retryable: false })
      return { model, stream: method === "streamGenerateContent" }
    }),
  )
}

type GatewayRoute = { model?: string; stream?: boolean; countTokens?: boolean }

/** "gemini-2.5-pro:streamGenerateContent" → ["gemini-2.5-pro", "streamGenerateContent"]. */
function splitGeminiTarget(target: string) {
  const index = target.lastIndexOf(":")
  if (index <= 0) throw new ApiError(404, "unsupported_method", "Expected models/{model}:{method}", { retryable: false })
  return [decodeURIComponent(target.slice(0, index)), target.slice(index + 1)] as const
}

function errorResponse(c: Context<AppEnv>, protocol: ProtocolAdapter, error: ApiError) {
  return c.json(protocol.errorBody(error.status, error.code, error.message), error.status, {
    "x-saorsa-request-id": c.get("requestID"),
    // Gateway decisions that cannot change on retry say so explicitly, so tools stop instead of looping.
    "x-should-retry": String(error.retry.retryable ?? (error.status === 429 || error.status >= 500)),
    ...error.headers,
  })
}

/**
 * Gateway credentials are client-session access tokens. Web console cookies are never accepted here,
 * and the billing project always comes from the server-side session, not from request headers.
 */
async function gatewayPrincipal(c: Context<AppEnv>) {
  const credential = bearer(c)
  if (!credential || credential.via !== "header") throw new ApiError(401, "unauthenticated", "Missing Saorsa client token")
  const deps = c.get("deps")
  const principal = await principalFromToken(deps, credential.token)
  if (!principal) {
    const login = `opencode auth login ${deps.env.TEAMOS_PUBLIC_URL}`
    if (await endedReason(deps, credential.token))
      throw new ApiError(401, "session_replaced", `账号已在其他设备登录 OpenCode，本设备已退出；如需在本机继续使用请运行：${login}（signed in on another device）`, {
        retryable: false,
      })
    throw new ApiError(401, "unauthenticated", `Saorsa 登录已失效或被撤销，请运行：${login}（Saorsa session expired or revoked）`, { retryable: false })
  }
  if (principal.sessionKind !== "client" || !principal.projectID)
    throw new ApiError(403, "client_session_required", "Gateway access requires an OpenCode client session")
  const [access] = await deps.sql`select p.status, p.code, exists(
      select 1 from project_members m where m.project_id = p.id and m.user_id = ${principal.userID}) as member
    from projects p where p.id = ${principal.projectID}`
  if (!access || access.status !== "active")
    throw new ApiError(403, "project_inactive", "The selected billing project is archived. Log in again and choose another project.")
  if (!access.member)
    throw new ApiError(403, "project_access_revoked", "You are no longer a member of the selected billing project.")
  // The tool comes from the session the token was issued for, never from client headers.
  const toolID = principal.toolID ?? "opencode"
  const [allowed] = await deps.sql`select 1 from project_tools where project_id = ${principal.projectID} and tool_id = ${toolID}`
  if (!allowed)
    throw new ApiError(
      403,
      "tool_not_allowed",
      `${toolByID(toolID)?.name ?? toolID} 未获准在当前计费项目组使用，请联系管理员（tool not authorized for this project group）`,
      { retryable: false },
    )
  await touchClientSession(deps, principal.sessionID)
  return { ...principal, toolID } as Principal & { projectID: string; toolID: string }
}

/** Models the project group authorizes, optionally narrowed to those a given tool may use. */
export async function authorizedModels(deps: Deps, projectID: string, toolID?: string) {
  const rows = await deps.sql`select m.id, m.alias, m.upstream_model, m.display_name, m.context_limit, m.output_limit,
      m.default_max_output, m.supports_tools, m.supports_reasoning, m.supports_streaming, m.supports_vision,
      m.supports_structured_output, m.allowed_tools, p.id as provider_id, p.base_url, p.protocol, p.extra_protocols,
      p.name as provider_name
    from models m
    join providers p on p.id = m.provider_id
    join model_permissions mp on mp.model_id = m.id and mp.project_id = ${projectID} and mp.allowed
    where m.enabled and p.enabled and (${toolID ?? null}::text is null or m.allowed_tools is null or ${toolID ?? null}::text = any(m.allowed_tools))
    order by m.alias`
  return rows as Array<{
    id: string
    alias: string
    upstream_model: string
    display_name: string
    context_limit: number | null
    output_limit: number | null
    default_max_output: number
    supports_tools: boolean
    supports_reasoning: boolean
    supports_streaming: boolean
    supports_vision: boolean
    supports_structured_output: boolean
    allowed_tools: string[] | null
    provider_id: string
    base_url: string
    protocol: string
    extra_protocols: string[]
    provider_name: string
  }>
}

/** Whether a model's provider serves a protocol (its primary protocol or one it also serves at the same URL). */
export function servesProtocol(model: { protocol: string; extra_protocols: string[] }, protocol: string) {
  return model.protocol === protocol || model.extra_protocols.includes(protocol)
}

async function governedRequest(c: Context<AppEnv>, protocol: ProtocolAdapter, route: GatewayRoute) {
  const deps = c.get("deps")
  const principal = await gatewayPrincipal(c)
  await requireClientVersion(deps, c.req.header("user-agent"))
  const raw = await c.req.arrayBuffer()
  if (raw.byteLength > MAX_BODY_BYTES) throw new ApiError(413, "request_too_large", "Request body exceeds 20MB", { retryable: false })
  const body = parseBody(raw)
  const request = readRequest(protocol, body, route)
  const model = await resolveModel(deps, principal.projectID, request.model, protocol, principal.toolID)
  requireCapabilities(model, protocol.features(body), request.stream)
  const startedAt = new Date()
  const price = await priceAt(deps.sql, model.id, startedAt)
  if (!price)
    throw new ApiError(503, "model_not_priced", `Model ${model.alias} has no price configured yet; ask an administrator`, { retryable: false })

  // Exclusive keys are claimed before admission so a member without a free key is never charged a rate slot.
  const exclusive = (await orgSettings(deps.sql)).keyAssignment === "exclusive"
  const leased = exclusive ? await claimKey(deps, principal.userID, model.providerID) : undefined
  if (exclusive && !leased) throw await noFreeKey(deps, model.providerID, principal.projectID)

  const requestID = c.get("requestID")
  // ~4 bytes per token: the admission estimate for token-per-minute windows, corrected with real usage later.
  const estimatedInputTokens = Math.ceil(raw.byteLength / 4)
  const admission = await admit(deps, principal, model, estimatedInputTokens, requestID)
  let releaseOnExit = true
  try {
    const idempotencyKey = headerToken(c.req.header("idempotency-key"), 200)
    // Newer clients send x-opencode-session-id; older official releases only send an affinity/session header.
    const openCodeSession = headerToken(
      c.req.header("x-opencode-session-id") ??
        c.req.header("x-claude-code-session-id") ??
        c.req.header("x-session-affinity") ??
        c.req.header("session_id") ??
        c.req.header("x-session-id"),
      128,
    )
    const projectSessionID = openCodeSession
      ? await linkProjectSession(deps, principal, openCodeSession)
      : undefined
    const [inserted] = await deps.sql`insert into gateway_requests (request_id, idempotency_key, trace_id, user_id, project_id,
        client_session_id, project_session_id, opencode_session_id, provider_id, model_id, model_alias, protocol, stream,
        price_version_id, currency, client_ip, user_agent, tool_id, tool_version, started_at)
      values (${requestID}, ${idempotencyKey ?? null}, ${headerToken(c.req.header("x-trace-id"), 64) ?? requestID}, ${principal.userID},
        ${principal.projectID}, ${principal.sessionID}, ${projectSessionID ?? null}, ${openCodeSession ?? null}, ${model.providerID},
        ${model.id}, ${model.alias}, ${protocol.id}, ${request.stream}, ${price.id}, ${price.currency}, ${clientIP(c)},
        ${c.req.header("user-agent")?.slice(0, 256) ?? null}, ${principal.toolID},
        ${toolVersionFromUserAgent(principal.toolID, c.req.header("user-agent")) ?? null}, ${startedAt})
      on conflict (user_id, idempotency_key) do nothing
      returning id`
    if (!inserted) {
      const [existing] = await deps.sql`select request_id, status from gateway_requests
        where user_id = ${principal.userID} and idempotency_key = ${idempotencyKey ?? ""}`
      throw new ApiError(
        409,
        "duplicate_request",
        `Idempotency-Key already used by ${existing?.request_id} (${existing?.status}); it was not charged again`,
        { retryable: false },
      )
    }
    const ctx: GatewayContext = {
      deps,
      protocol,
      principal,
      model,
      price,
      requestUUID: inserted.id,
      requestID,
      requestBytes: raw.byteLength,
      startedAt,
      tokenTicket: admission.ticket,
      leased,
      stream: request.stream,
    }

    const messages = protocol.messages(body)
    const rules = await loadRules(deps.sql)
    await precheckSecrets(ctx, messages, rules.get("secret_leak"))

    const maxOutput = clampMaxOutput(protocol.requestedMaxOutput(body), model)
    const estimate = estimateCeiling({ requestBytes: raw.byteLength, maxOutputTokens: maxOutput }, price)
    const settings = await orgSettings(deps.sql)
    await deps.sql
      .begin(async (tx) => {
        await reserve(tx, {
          userID: principal.userID,
          projectID: principal.projectID,
          modelID: model.id,
          requestUUID: ctx.requestUUID,
          estimateMicros: estimate,
          timezone: settings.timezone,
        })
        await tx`update gateway_requests set reserved_micros = ${estimate.toString()}::bigint where id = ${ctx.requestUUID}`
      })
      .catch(async (error) => {
        if (error instanceof ApiError) await reject(ctx, error)
        throw error
      })

    // Post-admission checks that never block: relevance hints are review prompts only.
    void relevanceCheck(ctx, messages, rules.get("project_relevance"), openCodeSession).catch((cause) =>
      deps.log.warn("relevance check failed", { cause: String(cause), requestID }),
    )

    const upstreamBody = protocol.prepareBody(body, model.upstreamModel, maxOutput, request.stream)
    const upstream = await callUpstream(ctx, upstreamBody, c.req.raw)
    if (!upstream.ok) {
      await finalize(ctx, {
        status: "failed",
        httpStatus: upstream.status,
        errorCode: upstream.code,
        errorMessage: upstream.message,
        usage: undefined,
        usageSource: "none",
      })
      throw new ApiError(upstream.clientStatus, upstream.code, upstream.message, upstream.retry)
    }
    releaseOnExit = false
    if (request.stream) return streamResponse(ctx, upstream.response, admission.lease.release)
    return await jsonResponse(ctx, upstream.response, admission.lease.release)
  } catch (error) {
    // Rejected before reaching the upstream: give back the admitted tokens.
    if (releaseOnExit) await deps.limiter.adjust(admission.ticket, 0).catch(() => {})
    throw error
  } finally {
    if (releaseOnExit) await admission.lease.release()
  }
}

function parseBody(raw: ArrayBuffer) {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(raw))
    if (isRecord(parsed)) return parsed
  } catch {}
  throw new ApiError(400, "invalid_json", "Request body must be a JSON object")
}

/**
 * Token counting (Claude Code's /v1/messages/count_tokens, Gemini CLI's :countTokens) is free at the providers
 * and only sizes context, so it is authenticated, authorized and sent with the member's key but not metered.
 */
async function countTokens(c: Context<AppEnv>, protocol: ProtocolAdapter, route: GatewayRoute) {
  const deps = c.get("deps")
  const principal = await gatewayPrincipal(c)
  const raw = await c.req.arrayBuffer()
  if (raw.byteLength > MAX_BODY_BYTES) throw new ApiError(413, "request_too_large", "Request body exceeds 20MB", { retryable: false })
  const body = parseBody(raw)
  const alias = route.model ?? body.model
  if (typeof alias !== "string" || !alias) throw new ApiError(400, "invalid_request", "model is required", { retryable: false })
  const model = await resolveModel(deps, principal.projectID, alias, protocol, principal.toolID)
  const exclusive = (await orgSettings(deps.sql)).keyAssignment === "exclusive"
  const credential = exclusive
    ? await claimKey(deps, principal.userID, model.providerID)
    : await pickCredential(deps, model.providerID, new Set())
  if (!credential) {
    if (exclusive) throw await noFreeKey(deps, model.providerID, principal.projectID)
    throw new ApiError(503, "no_credentials", "No active API key is available for this model's provider", { retryable: false })
  }
  const apiKey = deps.box.decrypt({ ciphertext: credential.ciphertext, nonce: credential.nonce, keyVersion: credential.key_version }, credential.id)
  const gemini = protocol.id === "gemini"
  const upstreamBody = gemini
    ? isRecord(body.generateContentRequest)
      ? { ...body, generateContentRequest: { ...body.generateContentRequest, model: `models/${model.upstreamModel}` } }
      : body
    : { ...body, model: model.upstreamModel }
  const response = await deps.fetch(
    `${model.baseURL}${gemini ? `/models/${encodeURIComponent(model.upstreamModel)}:countTokens` : "/messages/count_tokens"}`,
    {
      method: "POST",
      headers: protocol.upstreamHeaders(apiKey, c.req.raw.headers, false),
      body: JSON.stringify(upstreamBody),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    },
  )
  return new Response(redactSecrets(await response.text()), {
    status: response.status,
    headers: { "content-type": response.headers.get("content-type") ?? "application/json", "x-saorsa-request-id": c.get("requestID") },
  })
}

function readRequest(protocol: ProtocolAdapter, body: Record<string, unknown>, route: GatewayRoute) {
  try {
    return protocol.read(body, route)
  } catch (error) {
    if (error instanceof InvalidRequest) throw new ApiError(400, "invalid_request", error.message, { retryable: false })
    throw error
  }
}

/**
 * Rejects requests a model cannot serve before anything is reserved or sent upstream, with a message that names
 * the missing capability, instead of letting the provider fail in a tool-specific way.
 */
function requireCapabilities(model: ResolvedModel, features: Features, stream: boolean) {
  const missing = [
    features.tools && !model.capabilities.tools ? "tool use (function calling)" : undefined,
    stream && !model.capabilities.streaming ? "streaming" : undefined,
    features.images && !model.capabilities.vision ? "image input" : undefined,
    features.structuredOutput && !model.capabilities.structuredOutput ? "structured output" : undefined,
  ].filter((value) => value !== undefined)
  if (missing.length)
    throw new ApiError(
      400,
      "model_capability_unsupported",
      `模型 ${model.alias} 不支持：${missing.join("、")}。请在工具中换用支持该能力的模型（model ${model.alias} does not support ${missing.join(", ")}）`,
      { retryable: false },
    )
}

async function resolveModel(deps: Deps, projectID: string, alias: string, protocol: ProtocolAdapter, toolID: string): Promise<ResolvedModel> {
  const [row] = await deps.sql`select m.id, m.alias, m.upstream_model, m.enabled, m.default_max_output, m.output_limit,
      m.concurrency_limit, m.requests_per_minute, m.tokens_per_minute, m.allowed_tools, m.supports_tools, m.supports_streaming,
      m.supports_vision, m.supports_structured_output,
      p.id as provider_id, p.base_url, p.protocol, p.extra_protocols, p.enabled as provider_enabled,
      p.concurrency_limit as provider_concurrency_limit, p.requests_per_minute as provider_requests_per_minute,
      coalesce(mp.allowed, false) as allowed
    from models m join providers p on p.id = m.provider_id
    left join model_permissions mp on mp.model_id = m.id and mp.project_id = ${projectID}
    where lower(m.alias) = lower(${alias})`
  if (!row || !row.enabled || !row.provider_enabled)
    throw new ApiError(404, "model_not_found", `Model ${alias} is not available`, { retryable: false })
  if (!row.allowed)
    throw new ApiError(403, "model_not_allowed", `Model ${alias} is not authorized for your current billing project`, { retryable: false })
  if (row.allowed_tools && !row.allowed_tools.includes(toolID))
    throw new ApiError(403, "model_tool_not_allowed", `Model ${alias} is not enabled for ${toolByID(toolID)?.name ?? toolID}`, { retryable: false })
  if (!servesProtocol(row, protocol.id))
    throw new ApiError(400, "protocol_mismatch", `Model ${alias} is served by the ${row.protocol} endpoint, not ${protocol.id}`, {
      retryable: false,
    })
  return {
    id: row.id,
    alias: row.alias,
    upstreamModel: row.upstream_model,
    providerID: row.provider_id,
    baseURL: row.base_url,
    protocol: row.protocol,
    defaultMaxOutput: row.default_max_output,
    outputLimit: row.output_limit,
    capabilities: {
      tools: row.supports_tools,
      streaming: row.supports_streaming,
      vision: row.supports_vision,
      structuredOutput: row.supports_structured_output,
    },
    limits: {
      concurrency: row.concurrency_limit,
      requestsPerMinute: row.requests_per_minute,
      tokensPerMinute: row.tokens_per_minute,
      providerConcurrency: row.provider_concurrency_limit,
      providerRequestsPerMinute: row.provider_requests_per_minute,
    },
  }
}

/**
 * Applies every rate dimension before any work is recorded: member and project requests/tokens per minute
 * (organization defaults, per-project overrides), model and provider request rates, and member, project,
 * model and provider concurrency. Windows and slots are each checked atomically across replicas.
 */
async function admit(deps: Deps, principal: Principal & { projectID: string }, model: ResolvedModel, estimatedTokens: number, requestID: string) {
  const settings = await orgSettings(deps.sql)
  const [project] = await deps.sql`select concurrency_limit, requests_per_minute, tokens_per_minute from projects where id = ${principal.projectID}`
  const optional = <T,>(value: number | null | undefined, make: (limit: number) => T) => (value ? [make(value)] : [])
  const ticket = await deps.limiter.admit({
    estimatedTokens,
    requests: [
      { scope: `user:${principal.userID}`, limit: settings.userRequestsPerMinute, label: "your request rate" },
      { scope: `project:${principal.projectID}`, limit: project?.requests_per_minute ?? settings.projectRequestsPerMinute, label: "the project's request rate" },
      ...optional(model.limits.requestsPerMinute, (limit) => ({ scope: `model:${model.id}`, limit, label: `model ${model.alias}'s request rate` })),
      ...optional(model.limits.providerRequestsPerMinute, (limit) => ({ scope: `provider:${model.providerID}`, limit, label: "the provider's request rate" })),
    ],
    tokens: [
      ...optional(settings.userTokensPerMinute, (limit) => ({ scope: `user:${principal.userID}`, limit, label: "your token rate" })),
      ...optional(project?.tokens_per_minute ?? settings.projectTokensPerMinute, (limit) => ({
        scope: `project:${principal.projectID}`,
        limit,
        label: "the project's token rate",
      })),
      ...optional(model.limits.tokensPerMinute, (limit) => ({ scope: `model:${model.id}`, limit, label: `model ${model.alias}'s token rate` })),
    ],
  })
  try {
    const lease = await deps.limiter.acquire(
      [
        { scope: `user:${principal.userID}`, limit: settings.userConcurrency, label: "your concurrency limit", code: "concurrency_limited" as const },
        ...optional(project?.concurrency_limit, (limit) => ({
          scope: `project:${principal.projectID}`,
          limit,
          label: "the project's concurrency limit",
          code: "concurrency_limited" as const,
        })),
        ...optional(model.limits.concurrency, (limit) => ({ scope: `model:${model.id}`, limit, label: `model ${model.alias}'s concurrency limit`, code: "model_busy" as const })),
        ...optional(model.limits.providerConcurrency, (limit) => ({
          scope: `provider:${model.providerID}`,
          limit,
          label: "the provider's concurrency limit",
          code: "provider_busy" as const,
        })),
      ],
      requestID,
    )
    return { ticket, lease }
  } catch (error) {
    await deps.limiter.adjust(ticket, 0).catch(() => {})
    throw error
  }
}

/**
 * Members update OpenCode themselves; an optional organization floor turns an outdated client into a clear,
 * non-retryable instruction. Development builds ("opencode/local") and unknown agents are not blocked.
 */
async function requireClientVersion(deps: Deps, userAgent: string | undefined) {
  const minimum = (await orgSettings(deps.sql)).minOpenCodeVersion
  const version = clientVersion(userAgent)
  if (!minimum || !version || compareVersions(version, minimum) >= 0) return
  throw new ApiError(426, "client_outdated", `OpenCode ${version} 版本过旧，组织要求 ≥ ${minimum}。请运行 opencode upgrade 后重试。`, {
    retryable: false,
  })
}

export function clientVersion(userAgent: string | undefined) {
  return /\bopencode\/(\d+\.\d+\.\d+)/.exec(userAgent ?? "")?.[1]
}

export function compareVersions(a: string, b: string) {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let index = 0; index < 3; index++) if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0)
  return 0
}

/** Client-supplied identifiers are linkage only; keep them short and free of control or markup characters. */
function headerToken(value: string | undefined, max: number) {
  const cleaned = value?.replace(/[^A-Za-z0-9._:@/-]/g, "").slice(0, max)
  return cleaned || undefined
}

async function linkProjectSession(deps: Deps, principal: Principal & { projectID: string }, openCodeSession: string) {
  const [row] = await deps.sql`insert into project_sessions (user_id, project_id, client_session_id, opencode_session_id, request_count)
    values (${principal.userID}, ${principal.projectID}, ${principal.sessionID}, ${openCodeSession}, 1)
    on conflict (client_session_id, opencode_session_id)
      do update set last_seen_at = now(), request_count = project_sessions.request_count + 1
    returning id`
  return row.id as string
}

async function precheckSecrets(ctx: GatewayContext, messages: ChatMessage[], rule: { enabled: boolean; action: string } | undefined) {
  if (!rule?.enabled) return
  const findings = scanSecrets(messages)
  if (findings.length === 0) return
  const blocked = rule.action === "block"
  for (const event of secretRiskEvents(findings, { ...ctx.principal, blocked }))
    await recordRisk(ctx.deps, { ...event, requestUUID: ctx.requestUUID })
  await ctx.deps.sql`update gateway_requests set risk_level = 'high' where id = ${ctx.requestUUID}`
  if (!blocked) return
  const error = new ApiError(
    403,
    "policy_blocked",
    `Blocked by organization policy: the request contains what looks like a ${findings.map((finding) => finding.label).join(", ")}. Remove the secret and retry.`,
  )
  await reject(ctx, error)
  throw error
}

async function relevanceCheck(
  ctx: GatewayContext,
  messages: ChatMessage[],
  rule: { enabled: boolean; config: Record<string, unknown> } | undefined,
  openCodeSession: string | undefined,
) {
  if (!rule?.enabled) return
  const last = messages.at(-1)
  // Only a fresh human prompt is evaluated, not tool-loop steps, and at most once per OpenCode session.
  if (!isHumanPrompt(last)) return
  const prompt = messageText(last!)
  if (prompt.length < 40) return
  const [project] = await ctx.deps.sql`select name, purpose, description, tags from projects where id = ${ctx.principal.projectID}`
  if (!project?.purpose) return
  const dedupeKey = `relevance:${ctx.principal.userID}:${openCodeSession ?? ctx.requestID}`
  const config = rule.config
  if (config.mode === "audit_model") {
    if (config.allow_audit_model !== true || typeof config.model_alias !== "string") return
    const classifier = await auditClassifier(ctx.deps, config.model_alias)
    if (!classifier) return
    const verdict = await auditModelRelevance(ctx.deps, classifier, prompt, project)
    if (!verdict || verdict.related || verdict.confidence < 0.7) return
    await recordRisk(ctx.deps, {
      userID: ctx.principal.userID,
      projectID: ctx.principal.projectID,
      requestUUID: ctx.requestUUID,
      category: "project_relevance",
      severity: "info",
      confidence: verdict.confidence,
      detector: "classifier:audit_model",
      summary: `An audit model judged a prompt as possibly unrelated to project "${project.name}". Needs human review; may be a false positive.`,
      evidence: {
        classifier: config.model_alias,
        reasons: verdict.reasons.map((reason) => redactSecrets(reason)),
        confidence: verdict.confidence,
        explanation: "AI classifier output; not proof of misuse. Only the redacted prompt was sent to the organization's own managed model.",
      },
      dedupeKey,
    })
    return
  }
  const result = keywordRelevance(prompt, project)
  const minOverlap = typeof config.min_overlap === "number" ? config.min_overlap : 0.02
  if (!result || result.overlapRatio >= minOverlap) return
  await recordRisk(ctx.deps, {
    userID: ctx.principal.userID,
    projectID: ctx.principal.projectID,
    requestUUID: ctx.requestUUID,
    category: "project_relevance",
    severity: "info",
    confidence: 0.3,
    detector: "heuristic:keyword_overlap",
    summary: `Prompt shared ${result.matched.length} keywords with the registered purpose of "${project.name}". Weak signal for human review only.`,
    evidence: {
      overlap_ratio: Number(result.overlapRatio.toFixed(3)),
      threshold: minOverlap,
      matched_keywords: result.matched,
      project_keywords: result.projectKeywords,
      prompt_keyword_count: result.promptKeywordCount,
      explanation:
        "Keyword overlap between the prompt and the project purpose was below the configured threshold. Generic coding work often scores low; treat as a hint, not evidence.",
    },
    dedupeKey,
  })
}

/**
 * The relevance classifier is one of the organization's own managed OpenAI-compatible models, never a
 * free-form URL: content only goes to an already-approved upstream, and admins cannot point it at internal hosts.
 * Classifier calls are organization overhead and are not charged to the member.
 */
async function auditClassifier(deps: Deps, alias: string) {
  const [row] = await deps.sql`select m.upstream_model, p.id as provider_id, p.base_url from models m join providers p on p.id = m.provider_id
    where lower(m.alias) = lower(${alias}) and m.enabled and p.enabled and p.protocol = 'openai-chat'`
  if (!row) return undefined
  const credential = (await orgSettings(deps.sql)).keyAssignment === "exclusive"
    ? await freeCredential(deps.sql, row.provider_id)
    : await pickCredential(deps, row.provider_id, new Set())
  if (!credential) return undefined
  const apiKey = deps.box.decrypt({ ciphertext: credential.ciphertext, nonce: credential.nonce, keyVersion: credential.key_version }, credential.id)
  return { endpoint: row.base_url as string, model: row.upstream_model as string, apiKey }
}

/** Every upstream call carries an explicit output ceiling so the budget reservation is a true upper bound. */
function clampMaxOutput(requested: number | undefined, model: ResolvedModel) {
  const value = requested ?? model.defaultMaxOutput
  return model.outputLimit ? Math.min(value, model.outputLimit) : value
}

type RetryHint = { retryable?: boolean; retryAfterSeconds?: number }
type ClientStatus = 400 | 404 | 413 | 422 | 429 | 502 | 503 | 504
type UpstreamResult =
  | { ok: true; response: Response; credentialID: string }
  | { ok: false; status: number | null; clientStatus: ClientStatus; code: string; message: string; retry: RetryHint }

async function callUpstream(ctx: GatewayContext, body: Record<string, unknown>, client: Request): Promise<UpstreamResult> {
  const clientSignal = client.signal
  const { deps } = ctx
  let last: Extract<UpstreamResult, { ok: false }> = {
    ok: false,
    status: null,
    clientStatus: 503,
    code: "no_credentials",
    message: "No active API key is available for this model's provider. Ask an administrator to check Models & Keys.",
    retry: { retryable: false },
  }
  // Keys rejected for auth or quota are excluded for this request; transient failures may retry the same key.
  // With exclusive keys a rejected key moves the member to another free key, never onto someone else's.
  const excluded = new Set<string>()
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await Bun.sleep(150 * (attempt - 1))
    const credential = ctx.leased
      ? attempt === 1
        ? ctx.leased
        : await claimKey(deps, ctx.principal.userID, ctx.model.providerID, excluded)
      : await pickCredential(deps, ctx.model.providerID, excluded)
    if (!credential) break
    const apiKey = deps.box.decrypt(
      { ciphertext: credential.ciphertext, nonce: credential.nonce, keyVersion: credential.key_version },
      credential.id,
    )
    const [attemptRow] = await deps.sql`insert into gateway_attempts (request_id, attempt, credential_id)
      values (${ctx.requestUUID}, ${attempt}, ${credential.id}) returning id`
    await deps.sql`update gateway_requests set attempts = ${attempt}, credential_id = ${credential.id} where id = ${ctx.requestUUID}`
    const controller = new AbortController()
    const abort = () => controller.abort()
    clientSignal.addEventListener("abort", abort, { once: true })
    let timedOut = false
    const headerTimeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, deps.env.TEAMOS_UPSTREAM_HEADER_TIMEOUT_SECONDS * 1000)
    const response = await deps
      .fetch(`${ctx.model.baseURL}${ctx.protocol.upstreamPath(ctx.model.upstreamModel, ctx.stream)}`, {
        method: "POST",
        headers: ctx.protocol.upstreamHeaders(apiKey, client.headers, ctx.stream),
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      })
      .catch((cause: unknown) => cause as Error)
      .finally(() => clearTimeout(headerTimeout))
    if (response instanceof Error) {
      const message = clientSignal.aborted
        ? "Client disconnected"
        : timedOut
          ? `Upstream did not respond within ${deps.env.TEAMOS_UPSTREAM_HEADER_TIMEOUT_SECONDS}s`
          : `Upstream connection failed: ${response.name}`
      await deps.sql`update gateway_attempts set error = ${message}, ended_at = now() where id = ${attemptRow.id}`
      await markCredential(deps, credential.id, false, message)
      if (clientSignal.aborted) return { ...last, code: "client_cancelled", message, retry: { retryable: false } }
      last = timedOut
        ? { ok: false, status: null, clientStatus: 504, code: "upstream_timeout", message, retry: { retryable: true } }
        : { ok: false, status: null, clientStatus: 502, code: "upstream_unreachable", message, retry: { retryable: true } }
      // A timed-out attempt already waited minutes; let the client decide instead of stacking more waits here.
      if (timedOut) return last
      continue
    }
    await deps.sql`update gateway_attempts set http_status = ${response.status}, ended_at = now() where id = ${attemptRow.id}`
    if (response.ok) {
      await markCredential(deps, credential.id, true)
      return { ok: true, response, credentialID: credential.id }
    }
    const detail = await upstreamErrorDetail(response)
    const upstreamRetryAfter = retryAfterSeconds(response.headers)
    if (response.status === 401 || response.status === 403) {
      // The key is invalid or revoked upstream: cool it down and try another key of the same provider.
      await markCredential(deps, credential.id, false, `HTTP ${response.status}: ${detail.message}`, 30)
      excluded.add(credential.id)
      last = {
        ok: false,
        status: response.status,
        clientStatus: 502,
        code: "upstream_auth_failed",
        message: "The upstream provider rejected the organization API key. An administrator can see the failure on the key's health status.",
        retry: { retryable: false },
      }
      continue
    }
    if (response.status === 429 && /insufficient_quota|billing|quota|balance|credit/i.test(`${detail.code} ${detail.message}`)) {
      // The organization's provider account is out of credit: not a throttle, retrying cannot help.
      await markCredential(deps, credential.id, false, `HTTP 429 quota: ${detail.message}`, 30)
      excluded.add(credential.id)
      last = {
        ok: false,
        status: 429,
        clientStatus: 503,
        code: "upstream_account_quota",
        message: "The organization's provider account has no remaining quota. Ask an administrator to top it up or switch keys.",
        retry: { retryable: false },
      }
      continue
    }
    if (RETRYABLE.has(response.status)) {
      await markCredential(deps, credential.id, false, `HTTP ${response.status}: ${detail.message}`, response.status === 429 ? 1 : 0)
      if (response.status === 429) excluded.add(credential.id)
      last = {
        ok: false,
        status: response.status,
        clientStatus: response.status === 429 ? 429 : 503,
        code: response.status === 429 ? "upstream_rate_limited" : "upstream_unavailable",
        message:
          response.status === 429
            ? "The upstream provider is rate limiting the organization. Retrying automatically shortly."
            : `The upstream provider is temporarily unavailable (HTTP ${response.status}).`,
        retry: { retryable: true, retryAfterSeconds: upstreamRetryAfter ?? (response.status === 429 ? 5 : undefined) },
      }
      continue
    }
    // Other 4xx describe the request itself (context too long, bad parameters). Pass the status and the
    // provider's error code through so OpenCode can recognise e.g. context overflow and compact.
    return {
      ok: false,
      status: response.status,
      clientStatus: ([400, 404, 413, 422] as const).find((status) => status === response.status) ?? 400,
      code: detail.code ?? "upstream_rejected",
      message: `Upstream rejected the request (HTTP ${response.status}): ${detail.message}`,
      retry: { retryable: false },
    }
  }
  return last
}

function retryAfterSeconds(headers: Headers) {
  const millis = Number(headers.get("retry-after-ms"))
  if (Number.isFinite(millis) && millis > 0) return Math.min(300, Math.ceil(millis / 1000))
  const seconds = Number(headers.get("retry-after"))
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(300, Math.ceil(seconds))
  return undefined
}

async function pickCredential(deps: Deps, providerID: string, exclude: Set<string>) {
  const rows = await deps.sql`select id, ciphertext, nonce, key_version from provider_credentials
    where provider_id = ${providerID} and status = 'active' and (cooldown_until is null or cooldown_until < now())
    order by priority asc, last_used_at asc nulls first`
  return (rows as Array<{ id: string; ciphertext: Uint8Array; nonce: Uint8Array; key_version: number }>).find(
    (row) => !exclude.has(row.id),
  )
}

async function markCredential(deps: Deps, id: string, ok: boolean, error?: string, cooldownMinutes = 0) {
  if (ok) {
    await deps.sql`update provider_credentials set last_used_at = now(), failure_count = 0, last_error = null where id = ${id}`
    return
  }
  await deps.sql`update provider_credentials set failure_count = failure_count + 1, last_error = ${error?.slice(0, 300) ?? null},
      cooldown_until = case when ${cooldownMinutes} > 0 then now() + make_interval(mins => ${cooldownMinutes}) else cooldown_until end
    where id = ${id}`
}

/** Provider error text is stored and shown to members, so it is truncated and secrets are redacted. */
async function upstreamErrorDetail(response: Response) {
  const text = await response.text().catch(() => "")
  const clean = (value: string) => redactSecrets(value).slice(0, 300)
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string; code?: unknown; type?: unknown } | string; message?: string }
    const error = typeof parsed.error === "object" ? parsed.error : undefined
    const message = typeof parsed.error === "string" ? parsed.error : (error?.message ?? parsed.message)
    const code = typeof error?.code === "string" ? error.code : typeof error?.type === "string" ? error.type : undefined
    if (message) return { message: clean(message), code: code && /^[a-z0-9_.-]{1,64}$/i.test(code) ? code : undefined }
  } catch {}
  return { message: clean(text.slice(0, 200) || response.statusText), code: undefined }
}

async function jsonResponse(ctx: GatewayContext, response: Response, releaseSlot: () => Promise<void>) {
  try {
    const text = await withTimeout(response.text(), ctx.deps.env.TEAMOS_UPSTREAM_IDLE_TIMEOUT_SECONDS * 1000, () =>
      void response.body?.cancel().catch(() => {}),
    ).catch(async (cause: Error) => {
      await finalize(ctx, { status: "failed", httpStatus: response.status, usage: estimateUsage(ctx, 0), usageSource: "estimate", errorCode: "upstream_timeout", errorMessage: cause.message })
      throw new ApiError(504, "upstream_timeout", `Upstream response stalled: ${cause.message}`, { retryable: true })
    })
    const parsed = (() => {
      try {
        return JSON.parse(text) as Record<string, unknown>
      } catch {
        return undefined
      }
    })()
    const usage = parsed ? ctx.protocol.readUsage(parsed) : undefined
    const outputChars = parsed ? ctx.protocol.outputChars(parsed) : text.length
    await finalize(ctx, {
      status: "succeeded",
      httpStatus: response.status,
      usage: usage ?? estimateUsage(ctx, outputChars),
      usageSource: usage ? "upstream" : "estimate",
      upstreamRequestID: typeof parsed?.id === "string" ? parsed.id : (response.headers.get("x-request-id") ?? undefined),
      firstByteAt: new Date(),
    })
    return new Response(parsed ? JSON.stringify(ctx.protocol.clientResponse(parsed, ctx.model.alias)) : text, {
      status: response.status,
      headers: { "content-type": "application/json", "x-saorsa-request-id": ctx.requestID },
    })
  } finally {
    await releaseSlot()
  }
}

/**
 * Streams upstream SSE bytes through unchanged while parsing them for usage. If the client disconnects
 * the upstream call is aborted and the request settles with an explicitly estimated usage.
 */
function streamResponse(ctx: GatewayContext, upstream: Response, releaseSlot: () => Promise<void>) {
  const reader = upstream.body!.getReader()
  const decoder = new TextDecoder()
  const state: StreamState & { buffer: string; firstByteAt: Date | undefined } = {
    buffer: "",
    usage: undefined,
    usageFinal: false,
    upstreamID: undefined,
    outputChars: 0,
    firstByteAt: undefined,
  }
  let finished = false
  const finish = async (status: "succeeded" | "failed" | "cancelled", errorMessage?: string) => {
    if (finished) return
    finished = true
    try {
      // Exact only when the provider sent its final count. A partial count (stream cut before the end) keeps
      // its input/cache figures but the output is estimated from what was actually streamed. With no count at
      // all, the upstream had already accepted the prompt (HTTP 200), so input is estimated rather than dropped.
      const streamedOutput = Math.ceil(state.outputChars / 4)
      const exact = state.usage !== undefined && state.usageFinal
      const usage = state.usage
        ? exact
          ? state.usage
          : { ...state.usage, output: Math.max(state.usage.output, streamedOutput) }
        : estimateUsage(ctx, state.outputChars)
      await finalize(ctx, {
        status,
        httpStatus: upstream.status,
        usage,
        usageSource: exact ? "upstream" : "estimate",
        upstreamRequestID: state.upstreamID ?? upstream.headers.get("x-request-id") ?? undefined,
        errorCode: status === "succeeded" ? undefined : status === "cancelled" ? "client_cancelled" : "stream_interrupted",
        errorMessage,
        firstByteAt: state.firstByteAt,
      })
    } catch (cause) {
      ctx.deps.log.error("failed to finalize streamed request", { requestID: ctx.requestID, cause: String(cause) })
    } finally {
      await releaseSlot()
    }
  }
  const consume = (text: string) => {
    state.buffer += text
    const lines = state.buffer.split("\n")
    state.buffer = lines.pop() ?? ""
    for (const line of lines) {
      if (!line.startsWith("data:")) continue
      const data = line.slice(5).trim()
      if (ctx.protocol.isTerminator(data)) continue
      try {
        const chunk = JSON.parse(data) as unknown
        if (isRecord(chunk)) ctx.protocol.streamEvent(state, chunk)
      } catch {}
    }
  }
  // Fire-and-forget, so it can land after a very short stream has already settled: only a pending row moves.
  void ctx.deps.sql`update gateway_requests set status = 'streaming' where id = ${ctx.requestUUID} and status = 'pending'`.catch(() => {})
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await readWithIdleTimeout(reader, ctx.deps.env.TEAMOS_UPSTREAM_IDLE_TIMEOUT_SECONDS * 1000)
        if (done) {
          controller.close()
          await finish("succeeded")
          return
        }
        state.firstByteAt ??= new Date()
        consume(decoder.decode(value, { stream: true }))
        controller.enqueue(value)
      } catch (cause) {
        // Mid-stream upstream failure: surface an SSE error event so OpenCode shows a clear message.
        const message = `Upstream stream interrupted: ${cause instanceof Error ? cause.message : String(cause)}`
        controller.enqueue(new TextEncoder().encode(ctx.protocol.streamError(message)))
        controller.close()
        await finish("failed", message)
      }
    },
    async cancel() {
      await reader.cancel().catch(() => {})
      await finish("cancelled", "Client disconnected before the stream completed")
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      "x-saorsa-request-id": ctx.requestID,
    },
  })
}

/** Fallback when the provider reported no usage. Always persisted with estimated=true, never as exact. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout()
        reject(new Error(`no data from upstream for ${Math.round(ms / 1000)}s`))
      }, ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** A silent upstream must not hold a stream, its concurrency lease and its budget reservation forever. */
async function readWithIdleTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject before cancelling: cancel() settles the pending read as `done`, which must not read as success.
      reject(new Error(`no data from upstream for ${Math.round(idleMs / 1000)}s`))
      void reader.cancel().catch(() => {})
    }, idleMs)
  })
  try {
    return await Promise.race([reader.read(), idle])
  } finally {
    clearTimeout(timer)
  }
}

function estimateUsage(ctx: GatewayContext, outputChars: number): Usage {
  return {
    input: Math.ceil(ctx.requestBytes / 4),
    output: Math.ceil(outputChars / 4),
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  }
}

async function reject(ctx: GatewayContext, error: ApiError) {
  await ctx.deps.sql`update gateway_requests set status = 'rejected', http_status = ${error.status}, error_code = ${error.code},
      error_message = ${error.message}, billing_status = 'none', ended_at = now(),
      duration_ms = (extract(epoch from now() - started_at) * 1000)::int
    where id = ${ctx.requestUUID} and status = 'pending'`
  await ctx.deps.sql.begin((tx) => release(tx, ctx.requestUUID)).catch(() => {})
  await ctx.deps.realtime.publish({
    type: "usage.request",
    userID: ctx.principal.userID,
    projectID: ctx.principal.projectID,
    data: { requestID: ctx.requestID, status: "rejected", code: error.code, model: ctx.model.alias },
  })
}

interface Outcome {
  status: "succeeded" | "failed" | "cancelled"
  httpStatus: number | null
  usage: Usage | undefined
  usageSource: "upstream" | "estimate" | "none"
  upstreamRequestID?: string
  errorCode?: string
  errorMessage?: string
  firstByteAt?: Date
}

/**
 * Settles a request exactly once: ledger rows are unique per (request, category) and the request row is
 * locked, so a duplicate finalize (retry, cancel racing completion) cannot double charge.
 */
export async function finalize(ctx: GatewayContext, outcome: Outcome) {
  const { deps } = ctx
  const lines = outcome.usage ? billableLines(outcome.usage, ctx.price) : []
  const total = lines.reduce((sum, line) => sum + line.cost, 0n)
  const estimated = outcome.usageSource !== "upstream"
  const crossed = await deps.sql.begin(async (tx) => {
    const [request] = await tx`select status from gateway_requests where id = ${ctx.requestUUID} for update`
    if (!request || !["pending", "streaming"].includes(request.status)) return undefined
    for (const line of lines) {
      await tx`insert into usage_ledger (request_id, entry_type, category, tokens, unit_price_per_mtok_micros, cost_micros, currency,
          estimated, source, price_version_id, user_id, project_id, model_id, occurred_at)
        values (${ctx.requestUUID}, 'charge', ${line.category}, ${line.tokens}, ${line.unitPrice.toString()}::bigint,
          ${line.cost.toString()}::bigint, ${ctx.price.currency}, ${estimated}, ${outcome.usageSource === "none" ? "estimate" : outcome.usageSource},
          ${ctx.price.id}, ${ctx.principal.userID}, ${ctx.principal.projectID}, ${ctx.model.id}, ${ctx.startedAt})
        on conflict do nothing`
    }
    const usage = outcome.usage
    await tx`update gateway_requests set status = ${outcome.status}, http_status = ${outcome.httpStatus},
        error_code = ${outcome.errorCode ?? null}, error_message = ${outcome.errorMessage ? redactSecrets(outcome.errorMessage).slice(0, 500) : null},
        upstream_request_id = ${outcome.upstreamRequestID?.slice(0, 200) ?? null},
        billing_status = ${outcome.usageSource === "upstream" ? "exact" : outcome.usageSource === "estimate" ? "estimated" : lines.length ? "unknown" : "none"},
        input_tokens = ${usage?.input ?? 0}, output_tokens = ${usage?.output ?? 0}, cache_read_tokens = ${usage?.cacheRead ?? 0},
        cache_write_tokens = ${usage?.cacheWrite ?? 0}, reasoning_tokens = ${usage?.reasoning ?? 0},
        cost_micros = ${total.toString()}::bigint, first_byte_at = ${outcome.firstByteAt ?? null}, ended_at = now(),
        duration_ms = (extract(epoch from now() - started_at) * 1000)::int
      where id = ${ctx.requestUUID}`
    return settle(tx, ctx.requestUUID, total)
  })
  if (!crossed) return
  await deps.limiter
    .adjust(ctx.tokenTicket, (outcome.usage?.input ?? 0) + (outcome.usage?.output ?? 0))
    .catch((cause) => deps.log.warn("token window adjustment failed", { cause: String(cause) }))
  await deps.realtime.publish({
    type: "usage.request",
    userID: ctx.principal.userID,
    projectID: ctx.principal.projectID,
    data: {
      requestID: ctx.requestID,
      status: outcome.status,
      model: ctx.model.alias,
      inputTokens: outcome.usage?.input ?? 0,
      outputTokens: outcome.usage?.output ?? 0,
      costMicros: Number(total),
      billing: estimated ? (outcome.usageSource === "none" ? "none" : "estimated") : "exact",
    },
  })
  await alertThresholds(deps, ctx, crossed)
  await postRequestRisk(ctx).catch((cause) => deps.log.warn("post-request risk check failed", { cause: String(cause) }))
}

async function alertThresholds(deps: Deps, ctx: GatewayContext, crossed: CrossedThreshold[]) {
  if (crossed.length === 0) return
  const admins = await deps.sql`select id from users where account_type = 'ADMIN' and status = 'active' and deleted_at is null`
  for (const alert of crossed) {
    const text = `${alert.scopeType} ${alert.period} budget reached ${alert.threshold}% (${formatMoney(alert.spentMicros, alert.currency)} of ${formatMoney(alert.limitMicros, alert.currency)}).`
    const recipients = new Set<string>(admins.map((admin: { id: string }) => admin.id))
    if (alert.scopeType === "user" || alert.scopeType === "user_project") recipients.add(ctx.principal.userID)
    for (const userID of recipients)
      await notify(deps.sql, {
        userID,
        category: "budget",
        title: alert.threshold >= 100 ? "Budget limit reached" : `Budget ${alert.threshold}% used`,
        body: text,
        payload: { budgetID: alert.budgetID, threshold: alert.threshold },
      })
    await deps.realtime.publish({
      type: "budget.alert",
      userID: alert.scopeType === "user" || alert.scopeType === "user_project" ? ctx.principal.userID : undefined,
      projectID: ctx.principal.projectID,
      data: { budgetID: alert.budgetID, threshold: alert.threshold, message: text },
    })
  }
}

async function postRequestRisk(ctx: GatewayContext) {
  const rules = await loadRules(ctx.deps.sql)
  const burst = rules.get("request_burst")
  if (burst?.enabled) {
    const windowSeconds = Number(burst.config.window_seconds ?? 60)
    const max = Number(burst.config.max_requests ?? 120)
    const [row] = await ctx.deps.sql`select count(*)::int as n from gateway_requests
      where user_id = ${ctx.principal.userID} and started_at > now() - make_interval(secs => ${windowSeconds})`
    if (row.n > max) {
      const bucket = Math.floor(Date.now() / (windowSeconds * 1000))
      await recordRisk(ctx.deps, {
        userID: ctx.principal.userID,
        projectID: ctx.principal.projectID,
        requestUUID: ctx.requestUUID,
        category: "resource_abuse",
        severity: "review",
        confidence: 0.6,
        detector: "rule:request_burst",
        summary: `${row.n} gateway requests in ${windowSeconds}s exceeded the configured burst threshold of ${max}.`,
        evidence: { rule: "request_burst", count: row.n, window_seconds: windowSeconds, threshold: max, explanation: "Count of this member's managed requests in the window. Agent loops can legitimately produce bursts." },
        dedupeKey: `burst:${ctx.principal.userID}:${bucket}`,
      })
    }
  }
  const spike = rules.get("cost_spike")
  if (spike?.enabled) {
    const windowMinutes = Number(spike.config.window_minutes ?? 60)
    const max = BigInt(String(spike.config.max_micros ?? 20_000_000))
    const [row] = await ctx.deps.sql`select coalesce(sum(cost_micros), 0) as total from usage_ledger
      where user_id = ${ctx.principal.userID} and occurred_at > now() - make_interval(mins => ${windowMinutes})`
    if (BigInt(row.total) > max) {
      const bucket = Math.floor(Date.now() / (windowMinutes * 60_000))
      await recordRisk(ctx.deps, {
        userID: ctx.principal.userID,
        projectID: ctx.principal.projectID,
        requestUUID: ctx.requestUUID,
        category: "cost_anomaly",
        severity: "review",
        confidence: 0.6,
        detector: "rule:cost_spike",
        summary: `Spend of ${formatMoney(BigInt(row.total))} in ${windowMinutes} minutes exceeded the ${formatMoney(max)} threshold.`,
        evidence: { rule: "cost_spike", total_micros: Number(row.total), threshold_micros: Number(max), window_minutes: windowMinutes, explanation: "Sum of this member's ledger charges in the window." },
        dedupeKey: `spike:${ctx.principal.userID}:${bucket}`,
      })
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
