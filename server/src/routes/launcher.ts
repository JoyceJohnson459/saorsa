import type { Context, Hono } from "hono"
import { z } from "zod"
import { ApiError, type AppEnv, type Principal } from "../context.js"
import { clientIP, createLauncherSession, createTokenSession, principalFromToken, bearer, throttleIP, touchClientSession } from "../auth.js"
import { randomToken, sha256, userCode } from "../crypto.js"
import { audit } from "../audit.js"
import { authorizedModels, servesProtocol } from "../gateway.js"
import { memberProjects } from "./console.js"
import { TOOL_IDS, toolByID, type ToolID } from "../../../catalog/tools.js"

/**
 * Saorsa Launcher API. The Launcher signs in once per device (browser-approved device flow, like OpenCode) and
 * gets a Launcher session; it never receives provider keys. For each launch it asks for a short-lived token
 * bound to one tool and one project group, hands it to the child process environment, and reports what it
 * detected and did. Commands it runs come from its own compiled-in catalog, never from this API.
 */
const DEVICE_TTL_SECONDS = 600
const ToolIDSchema = z.enum(TOOL_IDS as [ToolID, ...ToolID[]])

export function launcherRoutes(app: Hono<AppEnv>) {
  app.post("/api/launcher/login", async (c) => {
    const deps = c.get("deps")
    await throttleIP(c, "device-code", 20)
    const body = DeviceFields.parse(await c.req.json())
    const deviceCode = randomToken("tos_dc")
    const code = userCode()
    await deps.sql`insert into device_authorizations (device_code_hash, user_code, client_label, interval_seconds, expires_at)
      values (${sha256(deviceCode)}, ${code}, ${`Saorsa Launcher · ${body.deviceLabel}`.slice(0, 120)}, 3,
        now() + make_interval(secs => ${DEVICE_TTL_SECONDS}))`
    return c.json({
      deviceCode,
      userCode: code,
      verificationURL: `${deps.env.TEAMOS_PUBLIC_URL}/device?code=${encodeURIComponent(code)}`,
      interval: 3,
      expiresIn: DEVICE_TTL_SECONDS,
    })
  })

  // 202 while pending; 200 with the Launcher token exactly once after approval; 410 when expired, denied or used.
  app.post("/api/launcher/login/poll", async (c) => {
    const deps = c.get("deps")
    await throttleIP(c, "device-token", 120)
    const body = z.object({ deviceCode: z.string().min(10).max(200) }).extend(DeviceFields.shape).parse(await c.req.json())
    const approved = await deps.sql.begin(async (tx) => {
      const [row] = await tx`select id, status, user_id, project_id, expires_at from device_authorizations
        where device_code_hash = ${sha256(body.deviceCode)} for update`
      if (!row || new Date(row.expires_at) < new Date() || ["denied", "consumed", "expired"].includes(row.status)) return "gone" as const
      await tx`update device_authorizations set last_polled_at = now() where id = ${row.id}`
      if (row.status === "pending") return "pending" as const
      await tx`update device_authorizations set status = 'consumed', consumed_at = now() where id = ${row.id}`
      return row as { user_id: string; project_id: string }
    })
    if (approved === "gone") return c.json({ error: { code: "expired", message: "Login expired or was denied; run `saorsa login` again" } }, 410)
    if (approved === "pending") return c.json({ status: "pending" }, 202)
    const session = await createLauncherSession(deps, {
      userID: approved.user_id,
      deviceID: body.deviceID,
      deviceLabel: body.deviceLabel,
      userAgent: c.req.header("user-agent")?.slice(0, 256),
      ip: clientIP(c),
    })
    await audit(deps.sql, {
      actor: { userID: approved.user_id, accountType: "MEMBER" },
      actorType: "member",
      action: "launcher.session_created",
      metadata: { sessionID: session.sessionID, deviceID: body.deviceID, os: body.os, arch: body.arch },
      ip: clientIP(c),
    })
    return c.json({ token: session.access, defaultProjectID: approved.project_id })
  })

  app.get("/api/launcher/me", async (c) => {
    const deps = c.get("deps")
    const principal = await launcherPrincipal(c)
    const projects = await memberProjects(deps, principal.userID)
    const grants = await deps.sql`select project_id, tool_id from project_tools
      where project_id = any(${deps.sql.array(projects.map((project) => project.id), "uuid")}::uuid[])`
    const [user] = await deps.sql`select username, display_name from users where id = ${principal.userID}`
    return c.json({
      user: { username: user.username, displayName: user.display_name },
      deviceID: principal.deviceID,
      projects: await Promise.all(
        projects.map(async (project) => ({
          id: project.id,
          code: project.code,
          name: project.name,
          tools: await Promise.all(
            grants
              .filter((grant: { project_id: string }) => grant.project_id === project.id)
              .map(async (grant: { tool_id: string }) => ({
                id: grant.tool_id,
                // Models this tool can use in this project: authorized, allowed for the tool, and on a protocol it speaks.
                models: (await authorizedModels(deps, project.id, grant.tool_id))
                  .filter((model) => toolByID(grant.tool_id)?.routes.some((route) => servesProtocol(model, route.protocol)))
                  .map((model) => ({ alias: model.alias, name: model.display_name, protocol: model.protocol, extraProtocols: model.extra_protocols })),
              })),
          ),
        })),
      ),
    })
  })

  /** A short-lived token for one launch of one tool, ending with this Launcher session. */
  app.post("/api/launcher/tool-token", async (c) => {
    const deps = c.get("deps")
    const principal = await launcherPrincipal(c)
    const body = z.object({ toolID: ToolIDSchema, projectID: z.string().uuid() }).parse(await c.req.json())
    await requireEntitlement(c, principal, body.toolID, body.projectID)
    const tool = toolByID(body.toolID)!
    const session = await createTokenSession(deps, {
      userID: principal.userID,
      projectID: body.projectID,
      toolID: body.toolID,
      deviceLabel: `${tool.name} via Launcher`,
      parentSessionID: principal.sessionID,
      ttlHours: deps.env.TEAMOS_TOOL_TOKEN_TTL_HOURS,
      userAgent: c.req.header("user-agent")?.slice(0, 256),
      ip: clientIP(c),
    })
    await touchClientSession(deps, principal.sessionID)
    return c.json({ token: session.access, expiresAt: session.expiresAt, origin: deps.env.TEAMOS_PUBLIC_URL })
  })

  /** A long-lived, revocable key for a tool configured in its own settings UI (IDE extensions, IDEs). */
  app.post("/api/launcher/tool-key", async (c) => {
    const deps = c.get("deps")
    const principal = await launcherPrincipal(c)
    const body = z.object({ toolID: ToolIDSchema, projectID: z.string().uuid() }).parse(await c.req.json())
    if (body.toolID === "opencode") throw new ApiError(409, "use_opencode_login", "OpenCode connects with `opencode auth login`")
    await requireEntitlement(c, principal, body.toolID, body.projectID)
    const session = await createTokenSession(deps, {
      userID: principal.userID,
      projectID: body.projectID,
      toolID: body.toolID,
      deviceLabel: `${toolByID(body.toolID)!.name} key`,
      userAgent: c.req.header("user-agent")?.slice(0, 256),
      ip: clientIP(c),
    })
    await audit(deps.sql, {
      actor: principal,
      action: "tool_key.created",
      targetType: "project",
      targetID: body.projectID,
      metadata: { toolID: body.toolID, sessionID: session.sessionID, via: "launcher" },
      ip: clientIP(c),
    })
    return c.json({ key: session.access, expiresAt: session.expiresAt }, 201)
  })

  // What the Launcher detected on this device. Upserted per tool; nothing about local projects or files.
  app.post("/api/launcher/report", async (c) => {
    const deps = c.get("deps")
    const principal = await launcherPrincipal(c)
    const body = z
      .object({
        deviceLabel: z.string().min(1).max(120),
        os: z.string().min(1).max(40),
        arch: z.string().min(1).max(20),
        launcherVersion: z.string().max(40),
        installations: z
          .array(
            z.object({
              toolID: ToolIDSchema,
              installed: z.boolean(),
              version: z.string().max(80).nullable(),
              configured: z.boolean(),
              error: z.string().max(300).nullable(),
            }),
          )
          .max(TOOL_IDS.length),
      })
      .parse(await c.req.json())
    for (const item of body.installations)
      await deps.sql`insert into managed_installations (user_id, device_id, device_label, os, arch, tool_id, installed, version, configured,
          last_error, launcher_version, reported_at)
        values (${principal.userID}, ${principal.deviceID!}, ${body.deviceLabel}, ${body.os}, ${body.arch}, ${item.toolID}, ${item.installed},
          ${item.version}, ${item.configured}, ${item.error}, ${body.launcherVersion}, now())
        on conflict (user_id, device_id, tool_id) do update set device_label = excluded.device_label, os = excluded.os, arch = excluded.arch,
          installed = excluded.installed, version = excluded.version, configured = excluded.configured, last_error = excluded.last_error,
          launcher_version = excluded.launcher_version, reported_at = now()`
    return c.json({ ok: true })
  })

  app.post("/api/launcher/events", async (c) => {
    const deps = c.get("deps")
    const principal = await launcherPrincipal(c)
    const body = z
      .object({
        toolID: ToolIDSchema.nullable(),
        action: z.enum(["install", "update", "uninstall", "configure", "restore", "launch", "doctor"]),
        outcome: z.enum(["succeeded", "failed", "cancelled"]),
        version: z.string().max(80).nullable(),
        detail: z.string().max(300).nullable(),
      })
      .parse(await c.req.json())
    await deps.sql`insert into launcher_events (user_id, device_id, tool_id, action, outcome, version, detail)
      values (${principal.userID}, ${principal.deviceID!}, ${body.toolID}, ${body.action}, ${body.outcome}, ${body.version}, ${body.detail})`
    return c.json({ ok: true })
  })

  app.post("/api/launcher/logout", async (c) => {
    const deps = c.get("deps")
    const principal = await launcherPrincipal(c)
    // Tool tokens it issued stop working with it (they are child sessions).
    await deps.sql`update user_sessions set revoked_at = now(), revoke_reason = 'logout' where id = ${principal.sessionID} and revoked_at is null`
    return c.json({ ok: true })
  })
}

const DeviceFields = z.object({
  deviceID: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  deviceLabel: z.string().min(1).max(80),
  os: z.string().min(1).max(40),
  arch: z.string().min(1).max(20),
})

async function launcherPrincipal(c: Context<AppEnv>) {
  const credential = bearer(c)
  if (!credential || credential.via !== "header") throw new ApiError(401, "unauthenticated", "Run `saorsa login` first")
  const principal = await principalFromToken(c.get("deps"), credential.token)
  if (!principal || principal.sessionKind !== "launcher")
    throw new ApiError(401, "unauthenticated", "Saorsa Launcher session expired, revoked or replaced on another device; run `saorsa login`")
  return principal
}

async function requireEntitlement(c: Context<AppEnv>, principal: Principal, toolID: string, projectID: string) {
  const deps = c.get("deps")
  if (!(await memberProjects(deps, principal.userID)).some((project) => project.id === projectID))
    throw new ApiError(403, "project_forbidden", "You are not a member of that project group")
  const [allowed] = await deps.sql`select 1 from project_tools where project_id = ${projectID} and tool_id = ${toolID}`
  if (!allowed) throw new ApiError(403, "tool_not_allowed", `${toolByID(toolID)?.name ?? toolID} is not authorized for that project group`)
}
