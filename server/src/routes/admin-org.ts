import type { Hono } from "hono"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import { ApiError, type AppEnv, type Deps } from "../context.js"
import { clientIP, hashPassword, passwordProblem } from "../auth.js"
import { audit } from "../audit.js"
import { num } from "../db.js"
import { summary } from "../usage.js"
import { budgetStatus } from "./budget-status.js"
import { TOOL_IDS, type ToolID } from "../../../catalog/tools.js"

const Username = z.string().regex(/^[a-zA-Z0-9._-]{3,40}$/, "3-40 letters, digits, dot, dash or underscore")
const NewUser = z.object({
  username: Username,
  displayName: z.string().min(1).max(80),
  email: z.string().email().max(200).optional().or(z.literal("").transform(() => undefined)),
  accountType: z.enum(["ADMIN", "MEMBER"]).default("MEMBER"),
  password: z.string().optional(),
  projectIDs: z.array(z.string().uuid()).default([]),
})

/** Readable one-time password; the user must change it on first login. Shown to the admin exactly once. */
function temporaryPassword() {
  const raw = randomBytes(18).toString("base64url")
  return `Tmp-${raw.slice(0, 6)}-${raw.slice(6, 12)}-${raw.slice(12, 18)}9!`
}

export function adminOrgRoutes(app: Hono<AppEnv>) {
  app.get("/api/admin/users", async (c) => {
    const deps = c.get("deps")
    const q = c.req.query("q")?.trim() ?? ""
    const status = c.req.query("status") ?? null
    const rows = await deps.sql`select u.id, u.username, u.email, u.display_name, u.account_type, u.status, u.must_change_password,
        u.last_login_at, u.created_at, u.locked_until,
        coalesce(json_agg(json_build_object('id', p.id, 'code', p.code, 'name', p.name) order by p.code)
          filter (where p.id is not null), '[]') as projects,
        (select count(*)::int from user_sessions s where s.user_id = u.id and s.kind = 'client' and s.revoked_at is null and s.expires_at > now()) as client_sessions
      from users u
      left join project_members m on m.user_id = u.id
      left join projects p on p.id = m.project_id
      where u.deleted_at is null
        and (${status}::text is null or u.status = ${status})
        and (${q} = '' or u.username ilike ${"%" + q + "%"} or u.display_name ilike ${"%" + q + "%"} or coalesce(u.email, '') ilike ${"%" + q + "%"})
      group by u.id order by u.account_type, u.username`
    return c.json({ users: rows })
  })

  app.post("/api/admin/users", async (c) => {
    const deps = c.get("deps")
    const body = NewUser.parse(await c.req.json())
    const created = await createUser(deps, body)
    await audit(deps.sql, {
      actor: c.get("principal"),
      action: "user.created",
      targetType: "user",
      targetID: created.id,
      metadata: { username: body.username, accountType: body.accountType, projects: body.projectIDs },
      ip: clientIP(c),
    })
    return c.json(created, 201)
  })

  app.post("/api/admin/users/import", async (c) => {
    const deps = c.get("deps")
    const body = z.object({ users: z.array(NewUser.omit({ password: true })).min(1).max(500) }).parse(await c.req.json())
    const results = []
    for (const user of body.users) {
      try {
        results.push({ ok: true, ...(await createUser(deps, user)) })
      } catch (error) {
        results.push({ ok: false, username: user.username, error: error instanceof Error ? error.message : String(error) })
      }
    }
    await audit(deps.sql, {
      actor: c.get("principal"),
      action: "user.imported",
      metadata: { count: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length },
      ip: clientIP(c),
    })
    return c.json({ results })
  })

  app.get("/api/admin/users/:id", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const [user] = await deps.sql`select id, username, email, display_name, account_type, status, must_change_password, last_login_at,
        created_at, locked_until, failed_logins, notice_ack_version, notice_ack_at
      from users where id = ${id} and deleted_at is null`
    if (!user) throw new ApiError(404, "not_found", "User not found")
    const projects = await deps.sql`select p.id, p.code, p.name, m.joined_at from project_members m join projects p on p.id = m.project_id
      where m.user_id = ${id} order by p.code`
    const sessions = await deps.sql`select s.id, s.kind, s.device_label, s.ip, s.created_at, s.last_used_at, s.expires_at,
        p.code as project_code,
        (select r.user_agent from gateway_requests r where r.client_session_id = s.id and r.user_agent is not null
          order by r.started_at desc limit 1) as client_agent
      from user_sessions s left join projects p on p.id = s.project_id
      where s.user_id = ${id} and s.revoked_at is null and s.expires_at > now() order by s.created_at desc`
    const month = new Date(Date.now() - 30 * 86400_000)
    return c.json({
      user,
      projects,
      sessions,
      usage: await summary(deps.sql, { userIDs: [id], from: month }),
      budgets: await budgetStatus(deps, { userID: id }),
    })
  })

  app.patch("/api/admin/users/:id", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const id = c.req.param("id")
    const body = z
      .object({
        displayName: z.string().min(1).max(80).optional(),
        email: z.string().email().max(200).nullable().optional(),
        status: z.enum(["active", "disabled"]).optional(),
        accountType: z.enum(["ADMIN", "MEMBER"]).optional(),
        unlock: z.boolean().optional(),
      })
      .parse(await c.req.json())
    if (id === principal.userID && (body.status === "disabled" || body.accountType === "MEMBER"))
      throw new ApiError(409, "self_lockout", "You cannot disable or demote your own account")
    if (body.status === "disabled" || body.accountType === "MEMBER") await ensureNotLastAdmin(deps, id)
    const [user] = await deps.sql`update users set
        display_name = coalesce(${body.displayName ?? null}, display_name),
        email = case when ${body.email !== undefined} then ${body.email ?? null} else email end,
        status = coalesce(${body.status ?? null}, status),
        account_type = coalesce(${body.accountType ?? null}, account_type),
        failed_logins = case when ${body.unlock === true} then 0 else failed_logins end,
        locked_until = case when ${body.unlock === true} then null else locked_until end,
        updated_at = now()
      where id = ${id} and deleted_at is null returning id, status`
    if (!user) throw new ApiError(404, "not_found", "User not found")
    // Disabling cuts off every live session immediately, including in-progress OpenCode clients.
    if (body.status === "disabled")
      await deps.sql`update user_sessions set revoked_at = now(), revoke_reason = 'user_disabled' where user_id = ${id} and revoked_at is null`
    await audit(deps.sql, { actor: principal, action: "user.updated", targetType: "user", targetID: id, metadata: body, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.post("/api/admin/users/:id/reset-password", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const password = temporaryPassword()
    const [user] = await deps.sql`update users set password_hash = ${await hashPassword(password)}, must_change_password = true,
        failed_logins = 0, locked_until = null, updated_at = now()
      where id = ${id} and deleted_at is null returning id`
    if (!user) throw new ApiError(404, "not_found", "User not found")
    await deps.sql`update user_sessions set revoked_at = now(), revoke_reason = 'password_reset' where user_id = ${id} and revoked_at is null`
    await audit(deps.sql, { actor: c.get("principal"), action: "user.password_reset", targetType: "user", targetID: id, ip: clientIP(c) })
    return c.json({ temporaryPassword: password })
  })

  app.post("/api/admin/users/:id/revoke-sessions", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const body = z.object({ sessionID: z.string().uuid().optional() }).parse(await c.req.json().catch(() => ({})))
    const rows = await deps.sql`update user_sessions set revoked_at = now(), revoke_reason = 'admin_revoked'
      where user_id = ${id} and revoked_at is null and (${body.sessionID ?? null}::uuid is null or id = ${body.sessionID ?? null})
      returning id`
    await audit(deps.sql, {
      actor: c.get("principal"),
      action: "user.sessions_revoked",
      targetType: "user",
      targetID: id,
      metadata: { count: rows.length, sessionID: body.sessionID },
      ip: clientIP(c),
    })
    return c.json({ revoked: rows.length })
  })

  // Soft delete: identity, usage history and audit trail remain; the account can no longer sign in.
  app.delete("/api/admin/users/:id", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const id = c.req.param("id")
    if (id === principal.userID) throw new ApiError(409, "self_lockout", "You cannot delete your own account")
    await ensureNotLastAdmin(deps, id)
    const [user] = await deps.sql.begin(async (tx) => {
      await tx`update user_sessions set revoked_at = now(), revoke_reason = 'user_deleted' where user_id = ${id} and revoked_at is null`
      await tx`delete from project_members where user_id = ${id}`
      return tx`update users set status = 'deleted', deleted_at = now(), updated_at = now() where id = ${id} and deleted_at is null returning id, username`
    })
    if (!user) throw new ApiError(404, "not_found", "User not found")
    await audit(deps.sql, { actor: principal, action: "user.deleted", targetType: "user", targetID: id, metadata: { username: user.username }, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.get("/api/admin/projects", async (c) => {
    const deps = c.get("deps")
    const status = c.req.query("status") ?? null
    const rows = await deps.sql`select p.id, p.code, p.name, p.description, p.purpose, p.tags, p.status, p.concurrency_limit, p.created_at,
        (select count(*)::int from project_members m join users u on u.id = m.user_id where m.project_id = p.id and u.deleted_at is null) as member_count,
        (select count(*)::int from model_permissions mp where mp.project_id = p.id and mp.allowed) as model_count,
        (select coalesce(sum(cost_micros), 0) from gateway_requests r where r.project_id = p.id and r.started_at > now() - interval '30 days') as cost_30d_micros,
        (select count(*)::int from gateway_requests r where r.project_id = p.id and r.started_at > now() - interval '30 days') as requests_30d
      from projects p where (${status}::text is null or p.status = ${status}) order by p.status, p.code`
    return c.json({ projects: rows.map((row: Record<string, unknown>) => ({ ...row, cost_30d_micros: num(row.cost_30d_micros) })) })
  })

  const ProjectFields = z.object({
    code: z.string().regex(/^[A-Za-z0-9_-]{2,32}$/, "2-32 letters, digits, dash or underscore"),
    name: z.string().min(1).max(100),
    description: z.string().max(2000).default(""),
    purpose: z.string().max(4000).default(""),
    tags: z.array(z.string().min(1).max(30)).max(20).default([]),
    concurrencyLimit: z.number().int().positive().max(1000).nullable().default(null),
    requestsPerMinute: z.number().int().positive().max(1_000_000).nullable().default(null),
    tokensPerMinute: z.number().int().min(1000).max(2_000_000_000).nullable().default(null),
  })

  app.post("/api/admin/projects", async (c) => {
    const deps = c.get("deps")
    const body = ProjectFields.parse(await c.req.json())
    const [exists] = await deps.sql`select 1 from projects where lower(code) = lower(${body.code})`
    if (exists) throw new ApiError(409, "duplicate_code", `Project code ${body.code} already exists`)
    const [project] = await deps.sql`insert into projects (code, name, description, purpose, tags, concurrency_limit, requests_per_minute, tokens_per_minute)
      values (${body.code}, ${body.name}, ${body.description}, ${body.purpose}, ${deps.sql.array(body.tags, "text")}, ${body.concurrencyLimit},
        ${body.requestsPerMinute}, ${body.tokensPerMinute})
      returning id`
    // New project groups start with OpenCode, the tool every member can connect without the Launcher.
    await deps.sql`insert into project_tools (project_id, tool_id) values (${project.id}, 'opencode')`
    await audit(deps.sql, { actor: c.get("principal"), action: "project.created", targetType: "project", targetID: project.id, metadata: body, ip: clientIP(c) })
    return c.json({ id: project.id }, 201)
  })

  app.get("/api/admin/projects/:id", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const [project] = await deps.sql`select id, code, name, description, purpose, tags, status, concurrency_limit, requests_per_minute,
        tokens_per_minute, created_at, archived_at
      from projects where id = ${id}`
    if (!project) throw new ApiError(404, "not_found", "Project not found")
    const members = await deps.sql`select u.id, u.username, u.display_name, u.status, m.joined_at
      from project_members m join users u on u.id = m.user_id where m.project_id = ${id} and u.deleted_at is null order by u.username`
    const models = await deps.sql`select m.id, m.alias, m.display_name, pr.name as provider_name, coalesce(mp.allowed, false) as allowed
      from models m join providers pr on pr.id = m.provider_id
      left join model_permissions mp on mp.model_id = m.id and mp.project_id = ${id}
      order by m.alias`
    const budgets = (await budgetStatus(deps, {})).filter(
      (budget: Record<string, unknown>) => budget.project_id === id,
    )
    const alerts = await deps.sql`select a.threshold, a.spent_micros, a.limit_micros, a.created_at, b.scope_type, b.period
      from budget_alerts a join budgets b on b.id = a.budget_id where b.project_id = ${id} order by a.created_at desc limit 20`
    const tools = (await deps.sql`select tool_id from project_tools where project_id = ${id}`).map((row: { tool_id: string }) => row.tool_id)
    return c.json({ project, members, models, budgets, alerts, tools })
  })

  app.patch("/api/admin/projects/:id", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const body = ProjectFields.partial().extend({ status: z.enum(["active", "archived"]).optional() }).parse(await c.req.json())
    if (body.code) {
      const [exists] = await deps.sql`select 1 from projects where lower(code) = lower(${body.code}) and id <> ${id}`
      if (exists) throw new ApiError(409, "duplicate_code", `Project code ${body.code} already exists`)
    }
    const [project] = await deps.sql`update projects set
        code = coalesce(${body.code ?? null}, code),
        name = coalesce(${body.name ?? null}, name),
        description = coalesce(${body.description ?? null}, description),
        purpose = coalesce(${body.purpose ?? null}, purpose),
        tags = coalesce(${body.tags ? deps.sql.array(body.tags, "text") : null}::text[], tags),
        concurrency_limit = case when ${body.concurrencyLimit !== undefined} then ${body.concurrencyLimit ?? null}::int else concurrency_limit end,
        requests_per_minute = case when ${body.requestsPerMinute !== undefined} then ${body.requestsPerMinute ?? null}::int else requests_per_minute end,
        tokens_per_minute = case when ${body.tokensPerMinute !== undefined} then ${body.tokensPerMinute ?? null}::int else tokens_per_minute end,
        status = coalesce(${body.status ?? null}, status),
        archived_at = case when ${body.status ?? null}::text = 'archived' then now() when ${body.status ?? null}::text = 'active' then null else archived_at end,
        updated_at = now()
      where id = ${id} returning id`
    if (!project) throw new ApiError(404, "not_found", "Project not found")
    await audit(deps.sql, { actor: c.get("principal"), action: "project.updated", targetType: "project", targetID: id, metadata: body, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.post("/api/admin/projects/:id/members", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const body = z.object({ userIDs: z.array(z.string().uuid()).min(1).max(500) }).parse(await c.req.json())
    const users = await deps.sql`select id from users where id = any(${deps.sql.array(body.userIDs, "uuid")}::uuid[]) and deleted_at is null`
    for (const user of users) await deps.sql`insert into project_members (project_id, user_id) values (${id}, ${user.id}) on conflict do nothing`
    await audit(deps.sql, {
      actor: c.get("principal"),
      action: "project.members_added",
      targetType: "project",
      targetID: id,
      metadata: { userIDs: users.map((user: { id: string }) => user.id) },
      ip: clientIP(c),
    })
    return c.json({ added: users.length })
  })

  // Removal takes effect on the next gateway request: membership is checked on every call.
  app.delete("/api/admin/projects/:id/members/:userID", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const userID = c.req.param("userID")
    const rows = await deps.sql`delete from project_members where project_id = ${id} and user_id = ${userID} returning id`
    if (rows.length === 0) throw new ApiError(404, "not_found", "Membership not found")
    await audit(deps.sql, { actor: c.get("principal"), action: "project.member_removed", targetType: "project", targetID: id, metadata: { userID }, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  // Which of the 12 catalog tools members may use when this project group is their billing project.
  app.put("/api/admin/projects/:id/tools", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const body = z.object({ toolIDs: z.array(z.enum(TOOL_IDS as [ToolID, ...ToolID[]])).max(TOOL_IDS.length) }).parse(await c.req.json())
    const [project] = await deps.sql`select id from projects where id = ${id}`
    if (!project) throw new ApiError(404, "not_found", "Project not found")
    await deps.sql.begin(async (tx) => {
      await tx`delete from project_tools where project_id = ${id}`
      for (const toolID of new Set(body.toolIDs)) await tx`insert into project_tools (project_id, tool_id) values (${id}, ${toolID})`
    })
    await audit(deps.sql, { actor: c.get("principal"), action: "project.tools_set", targetType: "project", targetID: id, metadata: body, ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.put("/api/admin/projects/:id/models", async (c) => {
    const deps = c.get("deps")
    const id = c.req.param("id")
    const body = z.object({ modelIDs: z.array(z.string().uuid()).max(500) }).parse(await c.req.json())
    await deps.sql.begin(async (tx) => {
      await tx`update model_permissions set allowed = false, updated_at = now() where project_id = ${id}`
      for (const modelID of body.modelIDs)
        await tx`insert into model_permissions (project_id, model_id, allowed) values (${id}, ${modelID}, true)
          on conflict (project_id, model_id) do update set allowed = true, updated_at = now()`
    })
    await audit(deps.sql, { actor: c.get("principal"), action: "project.models_set", targetType: "project", targetID: id, metadata: body, ip: clientIP(c) })
    return c.json({ ok: true })
  })
}

async function createUser(deps: Deps, body: z.infer<typeof NewUser>) {
  const password = body.password || temporaryPassword()
  const problem = passwordProblem(password, body.username)
  if (problem) throw new ApiError(422, "weak_password", problem)
  const [exists] = await deps.sql`select 1 from users where lower(username) = lower(${body.username}) and deleted_at is null`
  if (exists) throw new ApiError(409, "duplicate_username", `Username ${body.username} already exists`)
  const passwordHash = await hashPassword(password)
  const user = await deps.sql.begin(async (tx) => {
    const [user] = await tx`insert into users (username, email, display_name, password_hash, account_type, must_change_password)
      values (${body.username}, ${body.email ?? null}, ${body.displayName}, ${passwordHash}, ${body.accountType}, true)
      returning id`
    for (const projectID of body.projectIDs)
      await tx`insert into project_members (project_id, user_id) values (${projectID}, ${user.id}) on conflict do nothing`
    return user
  })
  return { id: user.id as string, username: body.username, temporaryPassword: body.password ? undefined : password }
}

async function ensureNotLastAdmin(deps: Deps, userID: string) {
  const [row] = await deps.sql`select count(*)::int as n from users
    where account_type = 'ADMIN' and status = 'active' and deleted_at is null and id <> ${userID}`
  const [target] = await deps.sql`select account_type from users where id = ${userID}`
  if (target?.account_type === "ADMIN" && row.n === 0) throw new ApiError(409, "last_admin", "At least one active administrator must remain")
}
