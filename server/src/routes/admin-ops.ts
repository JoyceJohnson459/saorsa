import type { Hono } from "hono"
import { z } from "zod"
import { ApiError, type AppEnv } from "../context.js"
import { clientIP } from "../auth.js"
import { audit, notify } from "../audit.js"
import { num } from "../db.js"
import { invalidateSettings, orgSettings } from "../settings.js"
import { breakdown, filterFromQuery, requests, summary, timeseries, toCSV } from "../usage.js"
import { budgetStatus } from "./budget-status.js"
import { parseMicros } from "./admin-models.js"
import { paging } from "./me.js"
import { sseStream } from "./sse.js"

export function adminOpsRoutes(app: Hono<AppEnv>) {
  app.get("/api/admin/usage/summary", async (c) => {
    const deps = c.get("deps")
    const filter = filterFromQuery(c.req.queries())
    const [totals, byModel] = await Promise.all([summary(deps.sql, filter), breakdown(deps.sql, filter, "model")])
    const [online] = await deps.sql`select count(distinct user_id)::int as n from user_sessions
      where kind = 'client' and revoked_at is null and last_used_at > now() - interval '15 minutes'`
    const [projects] = await deps.sql`select count(*)::int as n from projects where status = 'active'`
    const [risks] = await deps.sql`select count(*)::int as n from risk_events where status in ('open', 'appealed')`
    return c.json({ summary: totals, byModel, onlineMembers: online.n, activeProjectCount: projects.n, openRisks: risks.n })
  })

  app.get("/api/admin/usage/timeseries", async (c) => {
    const deps = c.get("deps")
    const settings = await orgSettings(deps.sql)
    const bucket = c.req.query("bucket") === "hour" ? "hour" : "day"
    return c.json({ timeseries: await timeseries(deps.sql, filterFromQuery(c.req.queries()), bucket, settings.timezone) })
  })

  app.get("/api/admin/usage/breakdown", async (c) => {
    const by = z.enum(["project", "user", "model", "provider", "tool"]).parse(c.req.query("by") ?? "project")
    return c.json({ by, rows: await breakdown(c.get("deps").sql, filterFromQuery(c.req.queries()), by) })
  })

  app.get("/api/admin/usage/requests", async (c) => {
    return c.json(await requests(c.get("deps").sql, filterFromQuery(c.req.queries()), paging(c.req.query())))
  })

  app.get("/api/admin/usage/requests/:id", async (c) => {
    const deps = c.get("deps")
    const [request] = await deps.sql`select r.*, p.code as project_code, u.username, pr.name as provider_name
      from gateway_requests r join projects p on p.id = r.project_id join users u on u.id = r.user_id
      left join providers pr on pr.id = r.provider_id where r.id = ${c.req.param("id")}`
    if (!request) throw new ApiError(404, "not_found", "Request not found")
    const ledger = await deps.sql`select entry_type, category, tokens, unit_price_per_mtok_micros, cost_micros, currency, estimated, source,
        note, created_at from usage_ledger where request_id = ${request.id} order by created_at`
    const attempts = await deps.sql`select a.attempt, a.http_status, a.error, a.started_at, a.ended_at, pc.label as credential_label
      from gateway_attempts a left join provider_credentials pc on pc.id = a.credential_id where a.request_id = ${request.id} order by a.attempt`
    const reservations = await deps.sql`select r.reserved_micros, r.settled_micros, r.status, b.scope_type, b.period
      from budget_reservations r join budgets b on b.id = r.budget_id where r.request_id = ${request.id}`
    return c.json({ request, ledger, attempts, reservations })
  })

  // Reconciliation against a provider bill: an audited ledger adjustment, never an edit of the original charge.
  app.post("/api/admin/usage/requests/:id/adjust", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const body = z.object({ deltaMicros: z.number().int(), note: z.string().min(3).max(500) }).parse(await c.req.json())
    const [request] = await deps.sql`select id, user_id, project_id, model_id, currency, price_version_id, started_at from gateway_requests
      where id = ${c.req.param("id")}`
    if (!request) throw new ApiError(404, "not_found", "Request not found")
    await deps.sql.begin(async (tx) => {
      await tx`insert into usage_ledger (request_id, entry_type, category, tokens, unit_price_per_mtok_micros, cost_micros, currency, estimated,
          source, price_version_id, user_id, project_id, model_id, occurred_at, note, created_by)
        values (${request.id}, 'adjustment', 'input', 0, 0, ${body.deltaMicros}, ${request.currency}, false, 'reconciliation',
          ${request.price_version_id}, ${request.user_id}, ${request.project_id}, ${request.model_id}, ${request.started_at}, ${body.note}, ${principal.userID})`
      await tx`update gateway_requests set cost_micros = cost_micros + ${body.deltaMicros}, billing_status = 'exact' where id = ${request.id}`
      await tx`update budget_counters c set spent_micros = greatest(0, c.spent_micros + ${body.deltaMicros})
        from budget_reservations r where r.request_id = ${request.id} and r.status = 'settled'
          and c.budget_id = r.budget_id and c.period_start = r.period_start`
    })
    await audit(deps.sql, { actor: principal, action: "usage.adjusted", targetType: "gateway_request", targetID: request.id, metadata: body, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.get("/api/admin/reports/export", async (c) => {
    const deps = c.get("deps")
    const filter = filterFromQuery(c.req.queries())
    const type = c.req.query("type") === "breakdown" ? "breakdown" : "requests"
    const money = (micros: number) => (micros / 1_000_000).toFixed(6)
    const csv =
      type === "breakdown"
        ? await (async () => {
            const by = z.enum(["project", "user", "model", "provider", "tool"]).parse(c.req.query("by") ?? "project")
            const rows = await breakdown(deps.sql, filter, by)
            return toCSV(
              rows.map((row: (typeof rows)[number]) => ({ ...row, cost: money(row.costMicros), estimated_cost: money(row.estimatedCostMicros) })),
              ["label", "requests", "succeeded", "failed", "rejected", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "cost", "estimated_cost", "estimatedRequests"],
            )
          })()
        : toCSV(
            (await requests(deps.sql, filter, { offset: 0, limit: 100_000, sort: "time" })).items.map((row: Record<string, unknown>) => ({
              ...row,
              cost: money(Number(row.cost_micros)),
            })),
            ["request_id", "started_at", "ended_at", "duration_ms", "status", "http_status", "error_code", "project_code", "username", "provider_name", "model_alias", "billing_status", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "cost", "currency", "risk_level", "opencode_session_id", "trace_id"],
          )
    await audit(deps.sql, { actor: c.get("principal"), action: "report.exported", metadata: { type, filter }, ip: clientIP(c) })
    return new Response(`﻿${csv}`, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="saorsa-${type}-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    })
  })

  app.get("/api/admin/budgets", async (c) => c.json({ budgets: await budgetStatus(c.get("deps"), {}) }))

  const BudgetBody = z.object({
    scopeType: z.enum(["org", "project", "user", "user_project", "model"]),
    projectID: z.string().uuid().nullable().default(null),
    userID: z.string().uuid().nullable().default(null),
    modelID: z.string().uuid().nullable().default(null),
    period: z.enum(["daily", "monthly", "total"]),
    limit: z.union([z.string(), z.number()]),
    currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
    warnThresholds: z.array(z.number().int().min(1).max(99)).max(5).default([80, 95]),
    hardLimit: z.boolean().default(true),
    perRequestMax: z.union([z.string(), z.number()]).nullable().default(null),
  })

  app.post("/api/admin/budgets", async (c) => {
    const deps = c.get("deps")
    const body = BudgetBody.parse(await c.req.json())
    const [exists] = await deps.sql`select id from budgets where scope_type = ${body.scopeType} and project_id is not distinct from ${body.projectID}
      and user_id is not distinct from ${body.userID} and model_id is not distinct from ${body.modelID} and period = ${body.period}`
    if (exists) throw new ApiError(409, "duplicate_budget", "A budget for this scope and period already exists; edit it instead")
    const [row] = await deps.sql`insert into budgets (scope_type, project_id, user_id, model_id, period, limit_micros, currency, warn_thresholds,
        hard_limit, per_request_max_micros)
      values (${body.scopeType}, ${body.projectID}, ${body.userID}, ${body.modelID}, ${body.period}, ${parseMicros(body.limit).toString()}::bigint,
        ${body.currency}, ${deps.sql.array(body.warnThresholds.toSorted((a, b) => a - b), "int4")}, ${body.hardLimit},
        ${body.perRequestMax === null ? null : parseMicros(body.perRequestMax).toString()}::bigint)
      returning id`.catch((error: Error) => {
      if (/check constraint/.test(error.message)) throw new ApiError(422, "invalid_scope", "Scope fields do not match the scope type")
      throw error
    })
    await audit(deps.sql, { actor: c.get("principal"), action: "budget.created", targetType: "budget", targetID: row.id, metadata: body, ip: clientIP(c) })
    return c.json({ id: row.id }, 201)
  })

  app.patch("/api/admin/budgets/:id", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const id = c.req.param("id")
    const body = z
      .object({
        limit: z.union([z.string(), z.number()]).optional(),
        warnThresholds: z.array(z.number().int().min(1).max(99)).max(5).optional(),
        hardLimit: z.boolean().optional(),
        enabled: z.boolean().optional(),
        perRequestMax: z.union([z.string(), z.number()]).nullable().optional(),
        note: z.string().max(500).optional(),
      })
      .parse(await c.req.json())
    const [before] = await deps.sql`select limit_micros from budgets where id = ${id}`
    if (!before) throw new ApiError(404, "not_found", "Budget not found")
    const limit = body.limit === undefined ? null : parseMicros(body.limit).toString()
    await deps.sql.begin(async (tx) => {
      await tx`update budgets set limit_micros = coalesce(${limit}::bigint, limit_micros),
          warn_thresholds = coalesce(${body.warnThresholds ? deps.sql.array(body.warnThresholds.toSorted((a, b) => a - b), "int4") : null}::int[], warn_thresholds),
          hard_limit = coalesce(${body.hardLimit ?? null}, hard_limit), enabled = coalesce(${body.enabled ?? null}, enabled),
          per_request_max_micros = case when ${body.perRequestMax !== undefined}
            then ${body.perRequestMax === undefined || body.perRequestMax === null ? null : parseMicros(body.perRequestMax).toString()}::bigint
            else per_request_max_micros end,
          updated_at = now()
        where id = ${id}`
      if (limit !== null)
        await tx`insert into budget_adjustments (budget_id, admin_id, kind, old_limit_micros, new_limit_micros, note)
          values (${id}, ${principal.userID}, 'set_limit', ${before.limit_micros}, ${limit}::bigint, ${body.note ?? null})`
    })
    await audit(deps.sql, { actor: principal, action: "budget.updated", targetType: "budget", targetID: id, metadata: body, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.post("/api/admin/budgets/:id/raise", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const id = c.req.param("id")
    const body = z
      .object({ amount: z.union([z.string(), z.number()]), expiresAt: z.coerce.date().nullable().default(null), note: z.string().min(3).max(500) })
      .parse(await c.req.json())
    const [budget] = await deps.sql`select id from budgets where id = ${id}`
    if (!budget) throw new ApiError(404, "not_found", "Budget not found")
    await deps.sql`insert into budget_adjustments (budget_id, admin_id, kind, delta_micros, expires_at, note)
      values (${id}, ${principal.userID}, 'temporary_raise', ${parseMicros(body.amount).toString()}::bigint, ${body.expiresAt}, ${body.note})`
    await audit(deps.sql, { actor: principal, action: "budget.raised", targetType: "budget", targetID: id, metadata: body, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.get("/api/admin/budgets/:id/adjustments", async (c) => {
    const rows = await c.get("deps").sql`select a.*, u.username as admin_username from budget_adjustments a join users u on u.id = a.admin_id
      where a.budget_id = ${c.req.param("id")} order by a.created_at desc`
    return c.json({ adjustments: rows })
  })

  app.get("/api/admin/budget-alerts", async (c) => {
    const rows = await c.get("deps").sql`select a.id, a.threshold, a.spent_micros, a.limit_micros, a.period_start, a.created_at,
        b.scope_type, b.period, b.currency, p.code as project_code, u.username, m.alias as model_alias
      from budget_alerts a join budgets b on b.id = a.budget_id
      left join projects p on p.id = b.project_id left join users u on u.id = b.user_id left join models m on m.id = b.model_id
      order by a.created_at desc limit 200`
    return c.json({ alerts: rows.map((row: Record<string, unknown>) => ({ ...row, spent_micros: num(row.spent_micros), limit_micros: num(row.limit_micros) })) })
  })

  app.get("/api/admin/risks", async (c) => {
    const deps = c.get("deps")
    const status = c.req.query("status") || null
    const severity = c.req.query("severity") || null
    const category = c.req.query("category") || null
    const user = c.req.query("user") || null
    const project = c.req.query("project") || null
    const rows = await deps.sql`select e.id, e.category, e.severity, e.confidence, e.detector, e.summary_redacted, e.status, e.created_at,
        e.updated_at, u.username, u.display_name, p.code as project_code, e.user_id, e.project_id,
        (select count(*)::int from risk_appeals a where a.risk_event_id = e.id) as appeal_count
      from risk_events e join users u on u.id = e.user_id left join projects p on p.id = e.project_id
      where (${status}::text is null or e.status = ${status}) and (${severity}::text is null or e.severity = ${severity})
        and (${category}::text is null or e.category = ${category}) and (${user}::uuid is null or e.user_id = ${user}::uuid)
        and (${project}::uuid is null or e.project_id = ${project}::uuid)
      order by case e.status when 'appealed' then 0 when 'open' then 1 else 2 end, e.created_at desc limit 500`
    return c.json({ risks: rows })
  })

  // Viewing evidence is itself audited, so access to sensitive excerpts is traceable.
  app.get("/api/admin/risks/:id", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const [event] = await deps.sql`select e.*, u.username, u.display_name, p.code as project_code, p.name as project_name, p.purpose as project_purpose,
        r.request_id as gateway_request_id, r.model_alias, r.started_at as request_started_at
      from risk_events e join users u on u.id = e.user_id left join projects p on p.id = e.project_id
      left join gateway_requests r on r.id = e.request_id where e.id = ${id}`
    if (!event) throw new ApiError(404, "not_found", "Risk event not found")
    const reviews = await deps.sql`select r.decision, r.note, r.created_at, u.username as reviewer from risk_reviews r
      join users u on u.id = r.reviewer_admin_id where r.risk_event_id = ${id} order by r.created_at`
    const appeals = await deps.sql`select message, created_at from risk_appeals where risk_event_id = ${id} order by created_at`
    await audit(deps.sql, { actor: c.get("principal"), action: "risk.viewed", targetType: "risk_event", targetID: id, ip: clientIP(c) })
    return c.json({ event, reviews, appeals })
  })

  app.post("/api/admin/risks/:id/review", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const id = c.req.param("id")
    const body = z.object({ decision: z.enum(["confirmed", "false_positive", "resolved", "open"]), note: z.string().min(2).max(2000) }).parse(await c.req.json())
    const [event] = await deps.sql`select id, user_id, summary_redacted from risk_events where id = ${id}`
    if (!event) throw new ApiError(404, "not_found", "Risk event not found")
    await deps.sql.begin(async (tx) => {
      await tx`insert into risk_reviews (risk_event_id, reviewer_admin_id, decision, note) values (${id}, ${principal.userID}, ${body.decision}, ${body.note})`
      await tx`update risk_events set status = ${body.decision}, updated_at = now() where id = ${id}`
    })
    const label = { confirmed: "confirmed", false_positive: "marked as a false positive", resolved: "resolved", open: "reopened" }[body.decision]
    await notify(deps.sql, {
      userID: event.user_id,
      category: "risk_review",
      title: `A risk notice was ${label}`,
      body: `${event.summary_redacted}\nReviewer note: ${body.note}`,
      payload: { riskEventID: id, decision: body.decision },
    })
    await audit(deps.sql, { actor: principal, action: "risk.reviewed", targetType: "risk_event", targetID: id, metadata: body, ip: clientIP(c) })
    await deps.realtime.publish({ type: "risk.reviewed", userID: event.user_id, data: { id, decision: body.decision } })
    return c.json({ ok: true })
  })

  app.get("/api/admin/policies", async (c) => {
    const rows = await c.get("deps").sql`select p.rule_type, p.enabled, p.action, p.config, p.updated_at, u.username as updated_by
      from policy_rules p left join users u on u.id = p.updated_by order by p.rule_type`
    return c.json({ policies: rows })
  })

  app.patch("/api/admin/policies/:ruleType", async (c) => {
    const deps = c.get("deps")
    const ruleType = c.req.param("ruleType")
    const body = z
      .object({ enabled: z.boolean().optional(), action: z.enum(["flag", "block"]).optional(), config: z.record(z.string(), z.unknown()).optional() })
      .parse(await c.req.json())
    // Only deterministic rules may block. AI or heuristic relevance can never stop a request.
    if (body.action === "block" && ruleType !== "secret_leak")
      throw new ApiError(422, "block_not_allowed", "Only the deterministic secret_leak rule may block requests")
    if (ruleType === "project_relevance" && body.config?.mode === "audit_model") {
      if (body.config.allow_audit_model !== true)
        throw new ApiError(422, "audit_model_consent", "Sending prompts to an audit model requires allow_audit_model=true (and an updated employee notice)")
      const [model] = await deps.sql`select 1 from models m join providers p on p.id = m.provider_id
        where lower(m.alias) = lower(${String(body.config.model_alias ?? "")}) and p.protocol = 'openai-chat'`
      if (!model)
        throw new ApiError(422, "audit_model_unknown", "model_alias must name a managed OpenAI-compatible model (a local model registered as a provider is recommended)")
    }
    const [row] = await deps.sql`update policy_rules set enabled = coalesce(${body.enabled ?? null}, enabled), action = coalesce(${body.action ?? null}, action),
        config = coalesce(${body.config ?? null}::jsonb, config), updated_by = ${c.get("principal").userID}, updated_at = now()
      where rule_type = ${ruleType} returning rule_type`
    if (!row) throw new ApiError(404, "not_found", "Unknown rule")
    await audit(deps.sql, { actor: c.get("principal"), action: "policy.updated", targetType: "policy_rule", targetID: ruleType, metadata: body, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.get("/api/admin/settings", async (c) => c.json({ settings: await orgSettings(c.get("deps").sql) }))

  app.patch("/api/admin/settings", async (c) => {
    const deps = c.get("deps")
    const body = z
      .object({
        name: z.string().min(1).max(100).optional(),
        timezone: z.string().min(1).max(64).optional(),
        userRequestsPerMinute: z.number().int().min(1).max(100_000).optional(),
        projectRequestsPerMinute: z.number().int().min(1).max(1_000_000).optional(),
        userConcurrency: z.number().int().min(1).max(1000).optional(),
        userTokensPerMinute: z.number().int().min(1000).max(1_000_000_000).nullable().optional(),
        projectTokensPerMinute: z.number().int().min(1000).max(10_000_000_000).nullable().optional(),
        noticeText: z.string().min(20).max(20_000).optional(),
        retainFullContent: z.literal(false).optional(),
        riskRetentionDays: z.number().int().min(30).max(3650).optional(),
        requestRetentionDays: z.number().int().min(30).max(3650).optional(),
        restrictToManagedProviders: z.boolean().optional(),
        minOpenCodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "Use a version like 1.19.0").nullable().optional(),
        singleDeviceLogin: z.boolean().optional(),
        keyAssignment: z.enum(["exclusive", "shared"]).optional(),
        keyLeaseIdleMinutes: z.number().int().min(5).max(1440).optional(),
      })
      .parse(await c.req.json())
    const current = await orgSettings(deps.sql)
    if (body.timezone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: body.timezone })
      } catch {
        throw new ApiError(422, "invalid_timezone", "Unknown IANA timezone")
      }
    }
    const { name, ...rest } = body
    // Any notice change bumps the version, so members must re-acknowledge before connecting a new client.
    const next = { ...rest, ...(body.noticeText && body.noticeText !== current.noticeText ? { noticeVersion: current.noticeVersion + 1 } : {}) }
    await deps.sql`update organization set name = coalesce(${name ?? null}, name), settings = settings || ${next}::jsonb where id = 1`
    invalidateSettings()
    await audit(deps.sql, { actor: c.get("principal"), action: "settings.updated", metadata: body, ip: clientIP(c) })
    return c.json({ settings: await orgSettings(deps.sql) })
  })

  app.get("/api/admin/audit-logs", async (c) => {
    const deps = c.get("deps")
    const action = c.req.query("action") || null
    const actor = c.req.query("actor") || null
    const page = paging(c.req.query())
    const rows = await deps.sql`select a.id, a.actor_type, a.action, a.target_type, a.target_id, a.metadata_redacted, a.ip, a.created_at,
        u.username as actor_username, count(*) over () as total
      from audit_logs a left join users u on u.id = a.actor_user_id
      where (${action}::text is null or a.action like ${(action ?? "") + "%"}) and (${actor}::uuid is null or a.actor_user_id = ${actor}::uuid)
      order by a.id desc offset ${page.offset} limit ${page.limit}`
    return c.json({ total: num(rows[0]?.total), items: rows.map((row: Record<string, unknown>) => ({ ...row, id: num(row.id), total: undefined })) })
  })

  app.get("/api/admin/system", async (c) => {
    const deps = c.get("deps")
    const [db] = await deps.sql`select version() as version, now() as now`
    const redis = await deps.redis.send("PING", []).then(() => "ok").catch((error: Error) => error.message)
    const providers = await deps.sql`select name, protocol, enabled, health_status, health_message, health_checked_at from providers order by name`
    const [pending] = await deps.sql`select count(*)::int as n from gateway_requests where status in ('pending', 'streaming')`
    const settings = await orgSettings(deps.sql)
    return c.json({
      database: { ok: true, version: db.version },
      redis: { ok: redis === "ok", detail: redis },
      providers,
      inFlightRequests: pending.n,
      rateLimitRejectionsLastHour: await deps.limiter.rejections(60),
      limits: {
        userRequestsPerMinute: settings.userRequestsPerMinute,
        projectRequestsPerMinute: settings.projectRequestsPerMinute,
        userTokensPerMinute: settings.userTokensPerMinute,
        projectTokensPerMinute: settings.projectTokensPerMinute,
        userConcurrency: settings.userConcurrency,
        upstreamHeaderTimeoutSeconds: deps.env.TEAMOS_UPSTREAM_HEADER_TIMEOUT_SECONDS,
        upstreamIdleTimeoutSeconds: deps.env.TEAMOS_UPSTREAM_IDLE_TIMEOUT_SECONDS,
      },
      gatewayURL: `${deps.env.TEAMOS_PUBLIC_URL}/gateway/v1`,
      coverage:
        "Monitoring covers managed traffic through the Saorsa gateway only. A member who runs an unmanaged OpenCode build or their own provider keys can bypass it; enforce with managed client config, network egress rules and device management.",
    })
  })

  app.get("/api/admin/events", (c) => sseStream(c, () => true))
}
