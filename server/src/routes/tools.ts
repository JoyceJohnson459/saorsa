import type { Hono } from "hono"
import { z } from "zod"
import { ApiError, type AppEnv, type Deps } from "../context.js"
import { clientIP, createTokenSession, requireAuth } from "../auth.js"
import { audit } from "../audit.js"
import { memberProjects } from "./console.js"
import { TOOL_IDS, TOOLS, toolByID, type ToolID, type ToolProfile } from "../../../catalog/tools.js"
import { GUIDES } from "../../../catalog/guides.js"
import { authorizedModels, servesProtocol } from "../gateway.js"

/**
 * The fixed 12-tool center. A tool's status is derived from evidence only: Launcher reports from members'
 * machines (installed), successful gateway requests attributed to the tool (gateway compatible), and requests
 * billed from the provider's exact usage (usage verified). Profile facts (partially managed, official account
 * required, limitations) come from the reviewed catalog, and `lab` from this repository's own test runs.
 * /api/admin/* and /api/me/* routes are authenticated by the middleware those route groups register.
 */
export function toolRoutes(app: Hono<AppEnv>) {
  app.get("/api/tools", requireAuth, async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const projects = await memberProjects(deps, principal.userID)
    const grants = await deps.sql`select project_id, tool_id from project_tools
      where project_id = any(${deps.sql.array(projects.map((project) => project.id), "uuid")}::uuid[])`
    const evidence = await toolEvidence(deps)
    return c.json({
      tools: TOOLS.map((tool) => ({
        ...publicProfile(tool),
        status: status(tool, evidence.get(tool.id)),
        projects: projects
          .filter((project) => grants.some((grant: { project_id: string; tool_id: string }) => grant.project_id === project.id && grant.tool_id === tool.id))
          .map((project) => ({ id: project.id, code: project.code, name: project.name })),
      })),
    })
  })

  /**
   * One tool with its connection guide and, per project group the caller belongs to, whether the tool is
   * authorized and which models it can use there (authorized, allowed for the tool, on a protocol it speaks).
   * Admins see the guide for every tool, entitled or not.
   */
  app.get("/api/tools/:id", requireAuth, async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const tool = toolByID(c.req.param("id"))
    if (!tool) throw new ApiError(404, "not_found", "Unknown tool")
    const projects = await memberProjects(deps, principal.userID)
    const grants = await deps.sql`select project_id from project_tools where tool_id = ${tool.id}
      and project_id = any(${deps.sql.array(projects.map((project) => project.id), "uuid")}::uuid[])`
    const evidence = await toolEvidence(deps)
    return c.json({
      tool: { ...publicProfile(tool), status: status(tool, evidence.get(tool.id)) },
      guide: GUIDES[tool.id],
      projects: await Promise.all(
        projects.map(async (project) => {
          const authorized = grants.some((grant: { project_id: string }) => grant.project_id === project.id)
          const models = authorized
            ? (await authorizedModels(deps, project.id, tool.id)).filter((model) => tool.routes.some((route) => servesProtocol(model, route.protocol)))
            : []
          return {
            id: project.id,
            code: project.code,
            name: project.name,
            authorized,
            models: models.map((model) => ({ alias: model.alias, name: model.display_name, protocol: model.protocol, provider: model.provider_name })),
          }
        }),
      ),
    })
  })

  app.get("/api/admin/tools", async (c) => {
    const deps = c.get("deps")
    const evidence = await toolEvidence(deps)
    const grants = await deps.sql`select tool_id, count(*)::int as projects from project_tools group by tool_id`
    return c.json({
      tools: TOOLS.map((tool) => ({
        ...publicProfile(tool),
        status: status(tool, evidence.get(tool.id)),
        evidence: evidence.get(tool.id) ?? emptyEvidence,
        projects: grants.find((grant: { tool_id: string }) => grant.tool_id === tool.id)?.projects ?? 0,
      })),
    })
  })

  // What each member's Launcher last reported, per device and tool.
  app.get("/api/admin/installations", async (c) => {
    const rows = await c.get("deps").sql`select i.user_id, u.username, u.display_name, i.device_id, i.device_label, i.os, i.arch, i.tool_id,
        i.installed, i.version, i.configured, i.last_error, i.launcher_version, i.reported_at
      from managed_installations i join users u on u.id = i.user_id
      order by i.reported_at desc limit 1000`
    return c.json({ installations: rows })
  })

  /**
   * A revocable Saorsa key bound to one project group and one tool, for tools configured in their own
   * settings UI (IDE extensions, IDEs) or run without the Launcher. Shown once and stored only as a hash;
   * issuing a new key for the same tool replaces the previous one when single-device login is on.
   */
  app.post("/api/me/tool-keys", async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    if (principal.sessionKind !== "web") throw new ApiError(403, "web_session_required", "Create tool keys from the Saorsa web console")
    const body = z.object({ toolID: z.enum(TOOL_IDS as [ToolID, ...ToolID[]]), projectID: z.string().uuid() }).parse(await c.req.json())
    if (body.toolID === "opencode")
      throw new ApiError(409, "use_opencode_login", "OpenCode connects with `opencode auth login`; it does not need a key")
    if (!(await memberProjects(deps, principal.userID)).some((project) => project.id === body.projectID))
      throw new ApiError(403, "project_forbidden", "You are not a member of that project group")
    const [allowed] = await deps.sql`select 1 from project_tools where project_id = ${body.projectID} and tool_id = ${body.toolID}`
    if (!allowed) throw new ApiError(403, "tool_not_allowed", "This tool is not authorized for that project group")
    const tool = toolByID(body.toolID)!
    const session = await createTokenSession(deps, {
      userID: principal.userID,
      projectID: body.projectID,
      toolID: body.toolID,
      deviceLabel: `${tool.name} key`,
      userAgent: c.req.header("user-agent")?.slice(0, 256),
      ip: clientIP(c),
    })
    await audit(deps.sql, {
      actor: principal,
      action: "tool_key.created",
      targetType: "project",
      targetID: body.projectID,
      metadata: { toolID: body.toolID, sessionID: session.sessionID },
      ip: clientIP(c),
    })
    return c.json({ key: session.access, toolID: body.toolID, projectID: body.projectID, sessionID: session.sessionID, expiresAt: session.expiresAt }, 201)
  })
}

/** The profile as served to browsers: everything except the server-side User-Agent pattern. */
export function publicProfile(tool: ToolProfile) {
  const { userAgent: _userAgent, ...profile } = tool
  return profile
}

const emptyEvidence = { installedDevices: 0, installedMembers: 0, succeeded: 0, exact: 0, lastSuccessAt: null, lastVersion: null }

type Evidence = typeof emptyEvidence | {
  installedDevices: number
  installedMembers: number
  succeeded: number
  exact: number
  lastSuccessAt: Date | null
  lastVersion: string | null
}

async function toolEvidence(deps: Deps) {
  const requests = await deps.sql`select tool_id,
      count(*) filter (where status = 'succeeded')::int as succeeded,
      count(*) filter (where status = 'succeeded' and billing_status = 'exact')::int as exact,
      max(started_at) filter (where status = 'succeeded') as last_success_at,
      (array_agg(tool_version order by started_at desc) filter (where tool_version is not null))[1] as last_version
    from gateway_requests where tool_id is not null group by tool_id`
  const installs = await deps.sql`select tool_id, count(*) filter (where installed)::int as devices,
      count(distinct user_id) filter (where installed)::int as members
    from managed_installations group by tool_id`
  return new Map<string, Evidence>(
    TOOL_IDS.map((id) => {
      const request = requests.find((row: { tool_id: string }) => row.tool_id === id)
      const install = installs.find((row: { tool_id: string }) => row.tool_id === id)
      return [
        id,
        {
          installedDevices: install?.devices ?? 0,
          installedMembers: install?.members ?? 0,
          succeeded: request?.succeeded ?? 0,
          exact: request?.exact ?? 0,
          lastSuccessAt: request?.last_success_at ?? null,
          lastVersion: request?.last_version ?? null,
        },
      ]
    }),
  )
}

/** The six status flags of the tool center; "listed" is never the same as "integrated". */
function status(tool: ToolProfile, evidence: Evidence | undefined) {
  return {
    available: (evidence?.installedDevices ?? 0) > 0,
    gatewayCompatible: (evidence?.succeeded ?? 0) > 0,
    usageVerified: (evidence?.exact ?? 0) > 0,
    partiallyManaged: tool.unmanaged.length > 0,
    officialAccountRequired: tool.officialAccount !== null,
    unsupportedCapabilities: tool.limitations,
  }
}
