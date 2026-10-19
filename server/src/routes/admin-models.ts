import type { Hono } from "hono"
import { z } from "zod"
import { ApiError, type AppEnv, type Deps } from "../context.js"
import { clientIP } from "../auth.js"
import { audit, notify } from "../audit.js"
import { keyPools, releaseKey } from "../keys.js"
import { TOOL_IDS, type ToolID } from "../../../catalog/tools.js"
import { maskSecret, sha256 } from "../crypto.js"
import { validateUpstreamBaseURL } from "../upstream.js"

/** Decimal money string per million tokens ("3", "0.15", "12.500000") → integer micros, without floats. */
export function parseMicros(value: string | number) {
  const text = String(value).trim()
  if (!/^\d{1,9}(\.\d{1,6})?$/.test(text)) throw new ApiError(422, "invalid_price", `Invalid price "${text}" (max 6 decimals)`)
  const [whole = "0", fraction = ""] = text.split(".")
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"))
}

const Price = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
  input: z.union([z.string(), z.number()]),
  output: z.union([z.string(), z.number()]),
  cacheRead: z.union([z.string(), z.number()]).default("0"),
  cacheWrite: z.union([z.string(), z.number()]).default("0"),
  reasoning: z.union([z.string(), z.number()]).nullable().default(null),
  source: z.string().max(200).default("manual"),
  effectiveFrom: z.coerce.date().optional(),
})

const Protocol = z.enum(["openai-chat", "anthropic-messages", "openai-responses", "gemini"])
/** null = every tool the project group allows; otherwise only these catalog tools may use the model. */
const AllowedTools = z.array(z.enum(TOOL_IDS as [ToolID, ...ToolID[]])).min(1).max(TOOL_IDS.length).nullable()

export function adminModelRoutes(app: Hono<AppEnv>) {
  app.get("/api/admin/providers", async (c) => {
    const deps = c.get("deps")
    const providers = await deps.sql`select id, name, protocol, extra_protocols, base_url, enabled, priority, health_status, health_message,
        health_checked_at, created_at, concurrency_limit, requests_per_minute from providers order by priority, name`
    // Expires idle exclusive leases first so the holders shown are current.
    await keyPools(deps)
    const credentials = await deps.sql`select c.id, c.provider_id, c.label, c.last4, c.fingerprint, c.key_version, c.status, c.priority,
        c.failure_count, c.cooldown_until, c.last_used_at, c.last_error, c.created_at, c.rotated_at, c.revoked_at,
        case when l.user_id is null then null else json_build_object('user_id', u.id, 'username', u.username, 'display_name', u.display_name,
          'claimed_at', l.claimed_at, 'last_used_at', l.last_used_at) end as lease
      from provider_credentials c
      left join credential_leases l on l.credential_id = c.id
      left join users u on u.id = l.user_id
      order by c.priority, c.created_at`
    return c.json({
      providers: providers.map((provider: { id: string }) => ({
        ...provider,
        // Secrets never leave the server: only a mask, fingerprint and status are returned.
        credentials: credentials
          .filter((credential: { provider_id: string }) => credential.provider_id === provider.id)
          .map((credential: { last4: string }) => ({ ...credential, masked: maskSecret(credential.last4) })),
      })),
    })
  })

  app.post("/api/admin/providers", async (c) => {
    const deps = c.get("deps")
    const body = z
      .object({
        name: z.string().min(1).max(80),
        protocol: Protocol.default("openai-chat"),
        extraProtocols: z.array(Protocol).max(3).default([]),
        baseURL: z.string().min(1).max(500),
        priority: z.number().int().min(0).max(1000).default(100),
        concurrencyLimit: z.number().int().positive().max(10_000).nullable().default(null),
        requestsPerMinute: z.number().int().positive().max(1_000_000).nullable().default(null),
      })
      .parse(await c.req.json())
    const baseURL = await validateUpstreamBaseURL(deps.env, body.baseURL)
    const [exists] = await deps.sql`select 1 from providers where lower(name) = lower(${body.name})`
    if (exists) throw new ApiError(409, "duplicate_provider", `Provider ${body.name} already exists`)
    const [provider] = await deps.sql`insert into providers (name, protocol, extra_protocols, base_url, priority, concurrency_limit, requests_per_minute)
      values (${body.name}, ${body.protocol}, ${deps.sql.array(body.extraProtocols.filter((value) => value !== body.protocol), "text")},
        ${baseURL}, ${body.priority}, ${body.concurrencyLimit}, ${body.requestsPerMinute}) returning id`
    await audit(deps.sql, { actor: c.get("principal"), action: "provider.created", targetType: "provider", targetID: provider.id, metadata: { ...body, baseURL }, ip: clientIP(c) })
    return c.json({ id: provider.id }, 201)
  })

  app.patch("/api/admin/providers/:id", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        baseURL: z.string().min(1).max(500).optional(),
        enabled: z.boolean().optional(),
        priority: z.number().int().min(0).max(1000).optional(),
        concurrencyLimit: z.number().int().positive().max(10_000).nullable().optional(),
        requestsPerMinute: z.number().int().positive().max(1_000_000).nullable().optional(),
        extraProtocols: z.array(Protocol).max(3).optional(),
      })
      .parse(await c.req.json())
    const baseURL = body.baseURL ? await validateUpstreamBaseURL(deps.env, body.baseURL) : null
    const [row] = await deps.sql`update providers set name = coalesce(${body.name ?? null}, name), base_url = coalesce(${baseURL}, base_url),
        enabled = coalesce(${body.enabled ?? null}, enabled), priority = coalesce(${body.priority ?? null}, priority),
        concurrency_limit = case when ${body.concurrencyLimit !== undefined} then ${body.concurrencyLimit ?? null}::int else concurrency_limit end,
        requests_per_minute = case when ${body.requestsPerMinute !== undefined} then ${body.requestsPerMinute ?? null}::int else requests_per_minute end,
        extra_protocols = case when ${body.extraProtocols !== undefined}
          then array(select unnest(${deps.sql.array(body.extraProtocols ?? [], "text")}::text[]) except select protocol)
          else extra_protocols end,
        updated_at = now()
      where id = ${id} returning id`
    if (!row) throw new ApiError(404, "not_found", "Provider not found")
    await audit(deps.sql, { actor: c.get("principal"), action: "provider.updated", targetType: "provider", targetID: id, metadata: body, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.post("/api/admin/providers/:id/credentials", async (c) => {
    const deps = c.get("deps")
    const providerID = c.req.param("id")
    const body = z
      .object({ label: z.string().min(1).max(80), apiKey: z.string().min(8).max(4096), priority: z.number().int().min(0).max(1000).default(100) })
      .parse(await c.req.json())
    const [provider] = await deps.sql`select id from providers where id = ${providerID}`
    if (!provider) throw new ApiError(404, "not_found", "Provider not found")
    const id = crypto.randomUUID()
    const sealed = deps.box.encrypt(body.apiKey.trim(), id)
    await deps.sql`insert into provider_credentials (id, provider_id, label, ciphertext, nonce, key_version, last4, fingerprint, priority)
      values (${id}, ${providerID}, ${body.label}, ${sealed.ciphertext}, ${sealed.nonce}, ${sealed.keyVersion},
        ${body.apiKey.trim().slice(-4)}, ${sha256(body.apiKey.trim()).slice(0, 12)}, ${body.priority})`
    await audit(deps.sql, {
      actor: c.get("principal"),
      action: "credential.created",
      targetType: "credential",
      targetID: id,
      metadata: { providerID, label: body.label, last4: body.apiKey.trim().slice(-4) },
      ip: clientIP(c),
    })
    return c.json({ id, masked: maskSecret(body.apiKey.trim().slice(-4)) }, 201)
  })

  app.post("/api/admin/credentials/:id/rotate", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const body = z.object({ apiKey: z.string().min(8).max(4096) }).parse(await c.req.json())
    const sealed = deps.box.encrypt(body.apiKey.trim(), id)
    const [row] = await deps.sql`update provider_credentials set ciphertext = ${sealed.ciphertext}, nonce = ${sealed.nonce},
        key_version = ${sealed.keyVersion}, last4 = ${body.apiKey.trim().slice(-4)}, fingerprint = ${sha256(body.apiKey.trim()).slice(0, 12)},
        rotated_at = now(), failure_count = 0, cooldown_until = null, last_error = null, status = 'active'
      where id = ${id} and status <> 'revoked' returning id`
    if (!row) throw new ApiError(404, "not_found", "Credential not found or revoked")
    await audit(deps.sql, { actor: c.get("principal"), action: "credential.rotated", targetType: "credential", targetID: id, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.patch("/api/admin/credentials/:id", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const body = z
      .object({ label: z.string().min(1).max(80).optional(), status: z.enum(["active", "disabled"]).optional(), priority: z.number().int().min(0).max(1000).optional() })
      .parse(await c.req.json())
    const [row] = await deps.sql`update provider_credentials set label = coalesce(${body.label ?? null}, label),
        status = coalesce(${body.status ?? null}, status), priority = coalesce(${body.priority ?? null}, priority),
        cooldown_until = case when ${body.status ?? null}::text = 'active' then null else cooldown_until end
      where id = ${id} and status <> 'revoked' returning id`
    if (!row) throw new ApiError(404, "not_found", "Credential not found or revoked")
    await audit(deps.sql, { actor: c.get("principal"), action: "credential.updated", targetType: "credential", targetID: id, metadata: body, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  // Frees an exclusive key held by a member (e.g. someone left for the day without logging out).
  app.delete("/api/admin/key-leases/:credentialID", async (c) => {
    const deps = c.get("deps")
    const released = await releaseKey(deps, { credentialID: c.req.param("credentialID") })
    if (!released) throw new ApiError(404, "not_found", "This key is not held by anyone")
    await notify(deps.sql, {
      userID: released.user_id,
      category: "key",
      title: "管理员已释放你占用的 Key",
      body: "下一次在 OpenCode 中调用时会自动分配空闲 Key；如果都在使用中，会提示可切换的模型。",
    })
    await audit(deps.sql, {
      actor: c.get("principal"),
      action: "key.released_by_admin",
      targetType: "credential",
      targetID: released.credential_id,
      metadata: { userID: released.user_id },
      ip: clientIP(c),
    })
    return c.json({ ok: true })
  })

  // Revocation destroys the ciphertext; the row remains so historical requests keep their reference.
  app.post("/api/admin/credentials/:id/revoke", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const [row] = await deps.sql`update provider_credentials set status = 'revoked', revoked_at = now(), ciphertext = decode('00', 'hex'),
        nonce = decode('00', 'hex') where id = ${id} and status <> 'revoked' returning id`
    if (!row) throw new ApiError(404, "not_found", "Credential not found or already revoked")
    await audit(deps.sql, { actor: c.get("principal"), action: "credential.revoked", targetType: "credential", targetID: id, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  // Re-encrypts every live credential with the active master key (run after adding a new key version).
  app.post("/api/admin/credentials/reencrypt", async (c) => {
    const deps = c.get("deps")
    const rows = await deps.sql`select id, ciphertext, nonce, key_version from provider_credentials
      where status <> 'revoked' and key_version <> ${deps.box.activeVersion}`
    for (const row of rows) {
      const plain = deps.box.decrypt({ ciphertext: row.ciphertext, nonce: row.nonce, keyVersion: row.key_version }, row.id)
      const sealed = deps.box.encrypt(plain, row.id)
      await deps.sql`update provider_credentials set ciphertext = ${sealed.ciphertext}, nonce = ${sealed.nonce}, key_version = ${sealed.keyVersion}
        where id = ${row.id}`
    }
    await audit(deps.sql, { actor: c.get("principal"), action: "credential.reencrypted", metadata: { count: rows.length }, ip: clientIP(c) })
    return c.json({ reencrypted: rows.length })
  })

  app.post("/api/admin/providers/:id/health", async (c) => {
    const deps = c.get("deps")
    const result = await checkProviderHealth(deps, c.req.param("id"))
    await audit(deps.sql, { actor: c.get("principal"), action: "provider.health_checked", targetType: "provider", targetID: c.req.param("id"), metadata: result, ip: clientIP(c) })
    return c.json(result)
  })

  app.get("/api/admin/models", async (c) => {
    const deps = c.get("deps")
    const rows = await deps.sql`select m.id, m.provider_id, pr.name as provider_name, pr.protocol, m.upstream_model, m.alias, m.display_name,
        m.context_limit, m.output_limit, m.default_max_output, m.supports_tools, m.supports_reasoning, m.supports_streaming,
        m.supports_vision, m.supports_structured_output, m.allowed_tools, pr.extra_protocols, m.enabled, m.created_at,
        m.concurrency_limit, m.requests_per_minute, m.tokens_per_minute,
        pv.id as price_id, pv.currency, pv.input_per_mtok_micros, pv.output_per_mtok_micros, pv.cache_read_per_mtok_micros,
        pv.cache_write_per_mtok_micros, pv.reasoning_per_mtok_micros, pv.effective_from, pv.source as price_source,
        (select count(*)::int from model_permissions mp where mp.model_id = m.id and mp.allowed) as project_count
      from models m join providers pr on pr.id = m.provider_id
      left join lateral (select * from pricing_versions p where p.model_id = m.id and p.effective_from <= now()
        order by p.effective_from desc, p.created_at desc limit 1) pv on true
      order by pr.name, m.alias`
    return c.json({ models: rows })
  })

  app.post("/api/admin/models", async (c) => {
    const deps = c.get("deps")
    const body = z
      .object({
        providerID: z.string().uuid(),
        upstreamModel: z.string().min(1).max(200),
        alias: z.string().regex(/^[A-Za-z0-9._:/-]{1,100}$/),
        displayName: z.string().min(1).max(100),
        contextLimit: z.number().int().positive().nullable().default(null),
        outputLimit: z.number().int().positive().nullable().default(null),
        defaultMaxOutput: z.number().int().positive().max(1_000_000).default(4096),
        supportsTools: z.boolean().default(true),
        supportsReasoning: z.boolean().default(false),
        supportsStreaming: z.boolean().default(true),
        supportsVision: z.boolean().default(false),
        supportsStructuredOutput: z.boolean().default(false),
        allowedTools: AllowedTools.default(null),
        price: Price,
      })
      .parse(await c.req.json())
    const [exists] = await deps.sql`select 1 from models where lower(alias) = lower(${body.alias})`
    if (exists) throw new ApiError(409, "duplicate_alias", `Model alias ${body.alias} already exists`)
    const id = await deps.sql.begin(async (tx) => {
      const [model] = await tx`insert into models (provider_id, upstream_model, alias, display_name, context_limit, output_limit,
          default_max_output, supports_tools, supports_reasoning, supports_streaming, supports_vision, supports_structured_output, allowed_tools)
        values (${body.providerID}, ${body.upstreamModel}, ${body.alias}, ${body.displayName}, ${body.contextLimit}, ${body.outputLimit},
          ${body.defaultMaxOutput}, ${body.supportsTools}, ${body.supportsReasoning}, ${body.supportsStreaming}, ${body.supportsVision},
          ${body.supportsStructuredOutput}, ${body.allowedTools ? deps.sql.array(body.allowedTools, "text") : null}) returning id`
      await insertPrice(tx as never, model.id, body.price, c.get("principal").userID)
      return model.id as string
    })
    await audit(deps.sql, { actor: c.get("principal"), action: "model.created", targetType: "model", targetID: id, metadata: body, ip: clientIP(c) })
    return c.json({ id }, 201)
  })

  app.patch("/api/admin/models/:id", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const body = z
      .object({
        displayName: z.string().min(1).max(100).optional(),
        contextLimit: z.number().int().positive().nullable().optional(),
        outputLimit: z.number().int().positive().nullable().optional(),
        defaultMaxOutput: z.number().int().positive().max(1_000_000).optional(),
        supportsTools: z.boolean().optional(),
        supportsReasoning: z.boolean().optional(),
        supportsStreaming: z.boolean().optional(),
        supportsVision: z.boolean().optional(),
        supportsStructuredOutput: z.boolean().optional(),
        allowedTools: AllowedTools.optional(),
        enabled: z.boolean().optional(),
        concurrencyLimit: z.number().int().positive().max(10_000).nullable().optional(),
        requestsPerMinute: z.number().int().positive().max(1_000_000).nullable().optional(),
        tokensPerMinute: z.number().int().min(1000).max(2_000_000_000).nullable().optional(),
      })
      .parse(await c.req.json())
    const [row] = await deps.sql`update models set display_name = coalesce(${body.displayName ?? null}, display_name),
        context_limit = case when ${body.contextLimit !== undefined} then ${body.contextLimit ?? null}::int else context_limit end,
        output_limit = case when ${body.outputLimit !== undefined} then ${body.outputLimit ?? null}::int else output_limit end,
        default_max_output = coalesce(${body.defaultMaxOutput ?? null}, default_max_output),
        supports_tools = coalesce(${body.supportsTools ?? null}, supports_tools),
        supports_reasoning = coalesce(${body.supportsReasoning ?? null}, supports_reasoning),
        supports_streaming = coalesce(${body.supportsStreaming ?? null}, supports_streaming),
        supports_vision = coalesce(${body.supportsVision ?? null}, supports_vision),
        supports_structured_output = coalesce(${body.supportsStructuredOutput ?? null}, supports_structured_output),
        allowed_tools = case when ${body.allowedTools !== undefined}
          then ${body.allowedTools ? deps.sql.array(body.allowedTools, "text") : null}::text[] else allowed_tools end,
        enabled = coalesce(${body.enabled ?? null}, enabled),
        concurrency_limit = case when ${body.concurrencyLimit !== undefined} then ${body.concurrencyLimit ?? null}::int else concurrency_limit end,
        requests_per_minute = case when ${body.requestsPerMinute !== undefined} then ${body.requestsPerMinute ?? null}::int else requests_per_minute end,
        tokens_per_minute = case when ${body.tokensPerMinute !== undefined} then ${body.tokensPerMinute ?? null}::int else tokens_per_minute end,
        updated_at = now()
      where id = ${id} returning id`
    if (!row) throw new ApiError(404, "not_found", "Model not found")
    await audit(deps.sql, { actor: c.get("principal"), action: "model.updated", targetType: "model", targetID: id, metadata: body, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.get("/api/admin/models/:id/prices", async (c) => {
    const rows = await c.get("deps").sql`select p.*, u.username as created_by_username from pricing_versions p
      left join users u on u.id = p.created_by where p.model_id = ${c.req.param("id")} order by p.effective_from desc, p.created_at desc`
    return c.json({ prices: rows })
  })

  // Prices are append-only versions; past requests keep the version they were billed with.
  app.post("/api/admin/models/:id/prices", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const body = Price.parse(await c.req.json())
    const [model] = await deps.sql`select id from models where id = ${id}`
    if (!model) throw new ApiError(404, "not_found", "Model not found")
    const priceID = await insertPrice(deps.sql, id, body, c.get("principal").userID)
    await audit(deps.sql, { actor: c.get("principal"), action: "model.price_added", targetType: "model", targetID: id, metadata: body, ip: clientIP(c) })
    return c.json({ id: priceID }, 201)
  })
}

async function insertPrice(sql: Deps["sql"], modelID: string, price: z.infer<typeof Price>, userID: string) {
  const [row] = await sql`insert into pricing_versions (model_id, currency, input_per_mtok_micros, output_per_mtok_micros,
      cache_read_per_mtok_micros, cache_write_per_mtok_micros, reasoning_per_mtok_micros, source, effective_from, created_by)
    values (${modelID}, ${price.currency}, ${parseMicros(price.input).toString()}::bigint, ${parseMicros(price.output).toString()}::bigint,
      ${parseMicros(price.cacheRead).toString()}::bigint, ${parseMicros(price.cacheWrite).toString()}::bigint,
      ${price.reasoning === null ? null : parseMicros(price.reasoning).toString()}::bigint, ${price.source},
      ${price.effectiveFrom ?? new Date()}, ${userID})
    returning id`
  return row.id as string
}

export async function checkProviderHealth(deps: Deps, providerID: string) {
  const [provider] = await deps.sql`select id, base_url, protocol from providers where id = ${providerID}`
  if (!provider) throw new ApiError(404, "not_found", "Provider not found")
  const [credential] = await deps.sql`select id, ciphertext, nonce, key_version from provider_credentials
    where provider_id = ${providerID} and status = 'active' order by priority, last_used_at nulls first limit 1`
  const record = async (status: "healthy" | "degraded" | "down", message: string) => {
    await deps.sql`update providers set health_status = ${status}, health_message = ${message.slice(0, 300)}, health_checked_at = now()
      where id = ${providerID}`
    return { status, message }
  }
  if (!credential) return record("down", "No active API key configured")
  const apiKey = deps.box.decrypt({ ciphertext: credential.ciphertext, nonce: credential.nonce, keyVersion: credential.key_version }, credential.id)
  const started = Date.now()
  const response = await deps
    .fetch(`${provider.base_url}/models`, {
      headers:
        provider.protocol === "anthropic-messages"
          ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
          : provider.protocol === "gemini"
            ? { "x-goog-api-key": apiKey }
            : { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    })
    .catch((cause: unknown) => cause as Error)
  if (response instanceof Error) return record("down", `Connection failed: ${response.name}`)
  const latency = Date.now() - started
  if (response.ok) return record("healthy", `HTTP 200 in ${latency}ms`)
  if (response.status === 401 || response.status === 403) {
    await deps.sql`update provider_credentials set last_error = ${`Health check HTTP ${response.status}`} where id = ${credential.id}`
    return record("down", `API key rejected (HTTP ${response.status})`)
  }
  return record("degraded", `HTTP ${response.status} in ${latency}ms`)
}
