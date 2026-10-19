import type { Hono } from "hono"
import { z } from "zod"
import { ApiError, type AppEnv } from "../context.js"
import { clientIP, requireAuth } from "../auth.js"
import { audit } from "../audit.js"
import { authorizedModels } from "../gateway.js"
import { orgSettings } from "../settings.js"
import { breakdown, filterFromQuery, requests, summary, timeseries, toolUsage } from "../usage.js"
import { TOOLS } from "../../../catalog/tools.js"
import { memberProjects } from "./console.js"
import { checkProjectSwitching } from "../switching.js"
import { sseStream } from "./sse.js"
import { budgetStatus } from "./budget-status.js"
import { claimKey, keyPools, noFreeKey, releaseKey } from "../keys.js"

/** Member self-service. Every query is pinned to the caller's own user ID on the server side. */
export function meRoutes(app: Hono<AppEnv>) {
  app.use("/api/me/*", requireAuth)

  app.get("/api/me/projects", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const projects = await memberProjects(deps, principal.userID)
    const withModels = await Promise.all(
      projects.map(async (project) => ({
        ...project,
        models: (await authorizedModels(deps, project.id)).map((model) => ({
          id: model.id,
          alias: model.alias,
          displayName: model.display_name,
          provider: model.provider_name,
        })),
      })),
    )
    return c.json({ projects: withModels })
  })

  app.get("/api/me/usage", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const filter = { ...filterFromQuery(c.req.queries()), userIDs: [principal.userID] }
    const settings = await orgSettings(deps.sql)
    const bucket = c.req.query("bucket") === "hour" ? "hour" : "day"
    const [totals, series, byProject, byModel, byTool] = await Promise.all([
      summary(deps.sql, filter),
      timeseries(deps.sql, filter, bucket, settings.timezone),
      breakdown(deps.sql, filter, "project"),
      breakdown(deps.sql, filter, "model"),
      breakdown(deps.sql, filter, "tool"),
    ])
    return c.json({ summary: totals, timeseries: series, byProject, byModel, byTool, currency: "USD" })
  })

  /**
   * Every tool the member has connected — an active OpenCode login or tool key, Launcher launches, a Launcher
   * install report, or traffic in the window — with its connections, devices and usage. Only the member's own
   * data; tokens and keys are never returned.
   */
  app.get("/api/me/tools/usage", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const days = Math.min(90, Math.max(1, Number(c.req.query("days")) || 30))
    const settings = await orgSettings(deps.sql)
    const from = new Date(Date.now() - days * 86400_000)
    const projects = await memberProjects(deps, principal.userID)
    const grants = await deps.sql`select project_id, tool_id from project_tools
      where project_id = any(${deps.sql.array(projects.map((project) => project.id), "uuid")}::uuid[])`
    const [usage, sessions, installs, launches] = await Promise.all([
      toolUsage(deps.sql, { userIDs: [principal.userID], from }, settings.timezone),
      deps.sql`select s.id, s.tool_id, s.device_label, s.created_at, s.last_used_at, s.expires_at, s.refresh_token_hash is not null as console_flow,
          s.project_id, p.code as project_code
        from user_sessions s left join projects p on p.id = s.project_id
        where s.user_id = ${principal.userID} and s.kind = 'client' and s.parent_session_id is null and s.revoked_at is null and s.expires_at > now()
        order by s.last_used_at desc nulls last, s.created_at desc`,
      deps.sql`select tool_id, device_label, os, arch, installed, version, configured, reported_at from managed_installations
        where user_id = ${principal.userID} order by reported_at desc`,
      deps.sql`select tool_id, count(*)::int as launches, max(created_at) as last_launch_at from user_sessions
        where user_id = ${principal.userID} and kind = 'client' and parent_session_id is not null and created_at >= ${from} group by 1`,
    ])
    const tools = TOOLS.map((tool) => {
      const connections = sessions
        .filter((session: { tool_id: string }) => session.tool_id === tool.id)
        .map((session: Record<string, unknown>) => ({
          id: session.id as string,
          kind: tool.id === "opencode" ? "opencode-login" : "tool-key",
          label: session.device_label as string,
          projectID: session.project_id as string,
          projectCode: session.project_code as string,
          createdAt: session.created_at as Date,
          lastUsedAt: (session.last_used_at as Date | null) ?? null,
          expiresAt: session.expires_at as Date,
        }))
      const devices = installs
        .filter((install: { tool_id: string }) => install.tool_id === tool.id)
        .map((install: Record<string, unknown>) => ({
          label: install.device_label as string,
          os: install.os as string,
          arch: install.arch as string,
          installed: install.installed as boolean,
          version: (install.version as string | null) ?? null,
          configured: install.configured as boolean,
          reportedAt: install.reported_at as Date,
        }))
      const launcher = launches.find((row: { tool_id: string }) => row.tool_id === tool.id)
      return {
        id: tool.id,
        name: tool.name,
        vendor: tool.vendor,
        connections,
        devices,
        launches: launcher ? { count: launcher.launches as number, lastAt: launcher.last_launch_at as Date } : null,
        usage: usage.get(tool.id) ?? null,
        // Project groups this member could bill the tool to (targets for switching a connection).
        projects: projects
          .filter((project) => grants.some((grant: { project_id: string; tool_id: string }) => grant.project_id === project.id && grant.tool_id === tool.id))
          .map((project) => ({ id: project.id, code: project.code, name: project.name })),
      }
    }).filter((tool) => tool.connections.length || tool.devices.some((device: { installed: boolean }) => device.installed) || tool.launches || tool.usage)
    return c.json({ days, from, tools, notConnected: TOOLS.length - tools.length })
  })

  app.get("/api/me/requests", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const filter = { ...filterFromQuery(c.req.queries()), userIDs: [principal.userID] }
    const page = paging(c.req.query())
    return c.json(await requests(deps.sql, filter, page))
  })

  app.get("/api/me/budgets", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    return c.json({ budgets: await budgetStatus(deps, { userID: principal.userID }) })
  })

  app.get("/api/me/sessions", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const rows = await deps.sql`select s.id, s.kind, s.device_label, s.user_agent, s.ip, s.created_at, s.last_used_at, s.expires_at,
        s.project_id, p.code as project_code, p.name as project_name
      from user_sessions s left join projects p on p.id = s.project_id
      where s.user_id = ${principal.userID} and s.revoked_at is null and s.expires_at > now()
      order by s.created_at desc`
    return c.json({ sessions: rows.map((row: Record<string, unknown>) => ({ ...row, current: row.id === principal.sessionID })) })
  })

  app.delete("/api/me/sessions/:id", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const [row] = await deps.sql`update user_sessions set revoked_at = now(), revoke_reason = 'member_revoked'
      where id = ${c.req.param("id")} and user_id = ${principal.userID} and revoked_at is null returning id`
    if (!row) throw new ApiError(404, "not_found", "Session not found")
    await audit(deps.sql, { actor: principal, action: "session.revoked", targetType: "session", targetID: row.id, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  // Switches the billing project of one of the caller's OpenCode client sessions. Takes effect on the next
  // gateway request; the OpenCode model list relabels itself on its next config refresh (about a minute).
  app.post("/api/me/active-project", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const body = z.object({ sessionID: z.string().uuid().optional(), projectID: z.string().uuid() }).parse(await c.req.json())
    const sessionID = body.sessionID ?? (principal.sessionKind === "client" ? principal.sessionID : undefined)
    if (!sessionID) throw new ApiError(422, "session_required", "Choose which tool connection to switch")
    const projects = await memberProjects(deps, principal.userID)
    if (!projects.some((project) => project.id === body.projectID))
      throw new ApiError(403, "project_forbidden", "You are not a member of that project")
    // A connection serves one tool; it can only move to a project group that allows that tool.
    const [allowed] = await deps.sql`select 1 from user_sessions s join project_tools t on t.tool_id = coalesce(s.tool_id, 'opencode')
      where s.id = ${sessionID} and s.user_id = ${principal.userID} and t.project_id = ${body.projectID}`
    if (!allowed) throw new ApiError(403, "tool_not_allowed", "该项目组没有授权这个工具（tool not authorized for that project group）")
    const [row] = await deps.sql`update user_sessions s set project_id = ${body.projectID}
      where s.id = ${sessionID} and s.user_id = ${principal.userID} and s.kind = 'client' and s.revoked_at is null
      returning (select project_id from user_sessions where id = ${sessionID}) as previous`
    if (!row) throw new ApiError(404, "not_found", "Tool connection not found")
    await audit(deps.sql, {
      actor: principal,
      action: "client.project_switched",
      targetType: "project",
      targetID: body.projectID,
      metadata: { sessionID, previousProjectID: row.previous },
      ip: clientIP(c),
    })
    await checkProjectSwitching(deps, principal.userID, body.projectID)
    return c.json({ ok: true })
  })

  // Exclusive keys: what the member's current OpenCode project can use, with live free-key counts.
  app.get("/api/me/keys", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const settings = await orgSettings(deps.sql)
    const pools = await keyPools(deps, principal.userID)
    const [session] = await deps.sql`select project_id from user_sessions where user_id = ${principal.userID} and kind = 'client'
      and revoked_at is null and expires_at > now() order by last_used_at desc nulls last, created_at desc limit 1`
    const models = session ? await authorizedModels(deps, session.project_id) : []
    const [lease] = await deps.sql`select provider_id, claimed_at, last_used_at from credential_leases where user_id = ${principal.userID}`
    return c.json({
      mode: settings.keyAssignment,
      idleMinutes: settings.keyLeaseIdleMinutes,
      connected: Boolean(session),
      pools: pools
        .map((pool) => ({ ...pool, models: models.filter((model) => model.provider_id === pool.id).map((model) => model.alias) }))
        .filter((pool) => pool.models.length),
      lease: lease ?? null,
    })
  })

  app.post("/api/me/keys/claim", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const body = z.object({ providerID: z.string().uuid() }).parse(await c.req.json())
    if ((await orgSettings(deps.sql)).keyAssignment !== "exclusive")
      throw new ApiError(409, "keys_shared", "Keys are shared by everyone; there is nothing to claim")
    const [session] = await deps.sql`select project_id from user_sessions where user_id = ${principal.userID} and kind = 'client'
      and revoked_at is null and expires_at > now() order by last_used_at desc nulls last, created_at desc limit 1`
    if (!session) throw new ApiError(409, "opencode_not_connected", "请先在 OpenCode 中登录 Saorsa（opencode auth login），再选择 Key")
    if (!(await authorizedModels(deps, session.project_id)).some((model) => model.provider_id === body.providerID))
      throw new ApiError(403, "provider_not_allowed", "Your current billing project has no models from this provider")
    if (!(await claimKey(deps, principal.userID, body.providerID))) throw await noFreeKey(deps, body.providerID, session.project_id)
    await audit(deps.sql, { actor: principal, action: "key.claimed", targetType: "provider", targetID: body.providerID, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.post("/api/me/keys/release", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const released = await releaseKey(deps, { userID: principal.userID })
    if (released)
      await audit(deps.sql, { actor: principal, action: "key.released", targetType: "credential", targetID: released.credential_id, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.get("/api/me/notifications", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const rows = await deps.sql`select id, category, title, body, payload, read_at, created_at from notifications
      where user_id = ${principal.userID} order by created_at desc limit 100`
    const [unread] = await deps.sql`select count(*)::int as n from notifications where user_id = ${principal.userID} and read_at is null`
    return c.json({ notifications: rows, unread: unread.n })
  })

  app.post("/api/me/notifications/read", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const body = z.object({ ids: z.array(z.string().uuid()).optional() }).parse(await c.req.json().catch(() => ({})))
    if (body.ids?.length)
      await deps.sql`update notifications set read_at = now() where user_id = ${principal.userID} and read_at is null
        and id = any(${deps.sql.array(body.ids, "uuid")}::uuid[])`
    else await deps.sql`update notifications set read_at = now() where user_id = ${principal.userID} and read_at is null`
    return c.json({ ok: true })
  })

  app.get("/api/me/risks", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const rows = await deps.sql`select e.id, e.category, e.severity, e.confidence, e.detector, e.summary_redacted, e.evidence, e.status,
        e.created_at, p.code as project_code,
        (select json_agg(json_build_object('decision', r.decision, 'note', r.note, 'created_at', r.created_at) order by r.created_at)
          from risk_reviews r where r.risk_event_id = e.id) as reviews,
        (select json_agg(json_build_object('message', a.message, 'created_at', a.created_at) order by a.created_at)
          from risk_appeals a where a.risk_event_id = e.id) as appeals
      from risk_events e left join projects p on p.id = e.project_id
      where e.user_id = ${principal.userID} order by e.created_at desc limit 200`
    return c.json({ risks: rows })
  })

  app.post("/api/me/risks/:id/appeal", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const body = z.object({ message: z.string().min(5).max(2000) }).parse(await c.req.json())
    const [event] = await deps.sql`select id, status from risk_events where id = ${c.req.param("id")} and user_id = ${principal.userID}`
    if (!event) throw new ApiError(404, "not_found", "Risk record not found")
    await deps.sql.begin(async (tx) => {
      await tx`insert into risk_appeals (risk_event_id, user_id, message) values (${event.id}, ${principal.userID}, ${body.message})`
      await tx`update risk_events set status = 'appealed', updated_at = now() where id = ${event.id} and status in ('open', 'confirmed')`
    })
    await audit(deps.sql, { actor: principal, action: "risk.appealed", targetType: "risk_event", targetID: event.id, ip: clientIP(c) })
    await deps.realtime.publish({ type: "risk.appealed", userID: principal.userID, data: { id: event.id } })
    return c.json({ ok: true })
  })

  app.get("/api/me/events", (c) => {
    const principal = c.get("principal")
    // Members only ever receive events that name them as the owner, plus the data-free key availability signal.
    return sseStream(c, (event) => event.userID === principal.userID || event.type === "key.lease")
  })
}

export function paging(query: Record<string, string>) {
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50))
  const offset = Math.max(0, Number(query.offset) || 0)
  return { limit, offset, sort: query.sort === "cost" ? ("cost" as const) : ("time" as const) }
}
