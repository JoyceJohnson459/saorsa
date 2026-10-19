import type { Hono } from "hono"
import { z } from "zod"
import { ApiError, type AppEnv, type Deps, type Principal } from "../context.js"
import { bearer, clientIP, createClientSession, principalFromToken, refreshClientSession, requireAuth, throttleIP } from "../auth.js"
import { randomToken, sha256, userCode } from "../crypto.js"
import { audit } from "../audit.js"
import { authorizedModels, servesProtocol } from "../gateway.js"
import { orgSettings } from "../settings.js"
import { checkProjectSwitching } from "../switching.js"
import { ANTHROPIC_PROVIDER, MCP_SERVER, PROVIDER } from "../brand.js"

const DEVICE_TTL_SECONDS = 600
const POLL_INTERVAL = 5

/**
 * OpenCode ships an organization connection ("OpenCode Console") that speaks an OAuth device flow plus
 * a remote-config endpoint. Saorsa implements that protocol so stock OpenCode clients connect with:
 *   opencode auth login opencode --answer server=<SAORSA_PUBLIC_URL>
 * Project groups appear to the client as organizations; the chosen one is the billing project.
 */
export function consoleRoutes(app: Hono<AppEnv>) {
  app.post("/auth/device/code", async (c) => {
    const deps = c.get("deps")
    await throttleIP(c, "device-code", 20)
    const body = await formOrJson(c.req.raw)
    const deviceCode = randomToken("tos_dc")
    const code = userCode()
    await deps.sql`insert into device_authorizations (device_code_hash, user_code, client_label, interval_seconds, expires_at)
      values (${sha256(deviceCode)}, ${code}, ${String(body.client_id ?? "opencode").slice(0, 64)}, ${POLL_INTERVAL},
        now() + make_interval(secs => ${DEVICE_TTL_SECONDS}))`
    return c.json({
      device_code: deviceCode,
      user_code: code,
      verification_uri: `${deps.env.TEAMOS_PUBLIC_URL}/device`,
      verification_uri_complete: `${deps.env.TEAMOS_PUBLIC_URL}/device?code=${encodeURIComponent(code)}`,
      expires_in: DEVICE_TTL_SECONDS,
      interval: POLL_INTERVAL,
    })
  })

  app.post("/auth/device/token", async (c) => {
    const deps = c.get("deps")
    // Polling every 5s is ~12/min per pending login; this leaves room for several logins behind one NAT.
    await throttleIP(c, "device-token", 120)
    const body = await formOrJson(c.req.raw)
    if (body.grant_type === "refresh_token") {
      const rotated = typeof body.refresh_token === "string" ? await refreshClientSession(deps, body.refresh_token) : undefined
      if (!rotated) return c.json({ error: "invalid_grant" }, 400)
      return c.json({
        access_token: rotated.access,
        refresh_token: rotated.refresh,
        expires_in: rotated.expiresIn,
        token_type: "Bearer",
        org_id: rotated.projectID,
      })
    }
    if (body.grant_type !== "urn:ietf:params:oauth:grant-type:device_code" || typeof body.device_code !== "string")
      return c.json({ error: "unsupported_grant_type" }, 400)
    const result = await deps.sql.begin(async (tx) => {
      const [row] = await tx`select id, status, user_id, project_id, expires_at, last_polled_at, interval_seconds, client_label
        from device_authorizations where device_code_hash = ${sha256(body.device_code as string)} for update`
      if (!row) return { error: "invalid_grant" as const }
      if (new Date(row.expires_at) < new Date()) {
        await tx`update device_authorizations set status = 'expired' where id = ${row.id} and status = 'pending'`
        return { error: "expired_token" as const }
      }
      const tooFast = row.last_polled_at && Date.now() - new Date(row.last_polled_at).getTime() < (row.interval_seconds - 1) * 1000
      await tx`update device_authorizations set last_polled_at = now() where id = ${row.id}`
      if (row.status === "denied") return { error: "access_denied" as const }
      if (row.status === "consumed") return { error: "invalid_grant" as const }
      if (row.status === "pending") return { error: tooFast ? ("slow_down" as const) : ("authorization_pending" as const) }
      await tx`update device_authorizations set status = 'consumed', consumed_at = now() where id = ${row.id}`
      return { approved: row as { id: string; user_id: string; project_id: string; client_label: string } }
    })
    if ("error" in result) return c.json({ error: result.error }, 400)
    const approved = result.approved
    const session = await createClientSession(deps, {
      userID: approved.user_id,
      projectID: approved.project_id,
      deviceLabel: approved.client_label,
      userAgent: c.req.header("user-agent")?.slice(0, 256),
      ip: clientIP(c),
    })
    await audit(deps.sql, {
      actor: { userID: approved.user_id, accountType: "MEMBER" },
      actorType: "member",
      action: "client.session_created",
      targetType: "project",
      targetID: approved.project_id,
      metadata: { sessionID: session.sessionID },
      ip: clientIP(c),
    })
    return c.json({
      access_token: session.access,
      refresh_token: session.refresh,
      expires_in: session.expiresIn,
      token_type: "Bearer",
      org_id: approved.project_id,
    })
  })

  app.get("/api/user", async (c) => {
    const principal = await clientPrincipal(c.get("deps"), c)
    const [user] = await c.get("deps").sql`select id, email, username from users where id = ${principal.userID}`
    return c.json({ id: user.id, email: user.email ?? `${user.username}@saorsa.local` })
  })

  app.get("/api/orgs", async (c) => {
    const deps = c.get("deps")
    const principal = await clientPrincipal(deps, c)
    const projects = await memberProjects(deps, principal.userID)
    return c.json(projects.map((project) => ({ id: project.id, name: `${project.code} · ${project.name}` })))
  })

  app.get("/api/v2/config", async (c) => {
    const deps = c.get("deps")
    const principal = await clientPrincipal(deps, c)
    const projectID = principal.projectID!
    const [project] = await deps.sql`select p.id, p.code, p.name, p.status, exists(
        select 1 from project_members m where m.project_id = p.id and m.user_id = ${principal.userID}) as member
      from projects p where p.id = ${projectID}`
    // Unauthorized is the Console's signal for "reconnect", which makes OpenCode prompt a new login.
    if (!project || project.status !== "active" || !project.member) return c.json({ _tag: "Unauthorized" }, 401)
    return c.json(await remoteConfig(deps, project))
  })

  // Browser side of the device flow: an authenticated member approves the code and picks a billing project.
  app.get("/api/device/:code", requireAuth, async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const [row] = await deps.sql`select user_code, status, client_label, expires_at from device_authorizations
      where user_code = ${c.req.param("code").toUpperCase()}`
    if (!row || row.status !== "pending" || new Date(row.expires_at) < new Date())
      throw new ApiError(404, "device_code_invalid", "This code is invalid or expired. Start the login again in OpenCode.")
    const settings = await orgSettings(deps.sql)
    const [user] = await deps.sql`select notice_ack_version from users where id = ${principal.userID}`
    return c.json({
      userCode: row.user_code,
      clientLabel: row.client_label,
      expiresAt: row.expires_at,
      projects: await memberProjects(deps, principal.userID),
      notice: { version: settings.noticeVersion, text: settings.noticeText, acknowledged: user.notice_ack_version === settings.noticeVersion },
    })
  })

  app.post("/api/device/approve", requireAuth, async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const body = z
      .object({ userCode: z.string().min(4).max(20), projectID: z.string().uuid(), acknowledgeNotice: z.boolean() })
      .parse(await c.req.json())
    const settings = await orgSettings(deps.sql)
    if (!body.acknowledgeNotice) throw new ApiError(422, "notice_required", "You must acknowledge the usage notice to connect")
    const projects = await memberProjects(deps, principal.userID)
    if (!projects.some((project) => project.id === body.projectID))
      throw new ApiError(403, "project_forbidden", "You are not a member of that project")
    const [updated] = await deps.sql`update device_authorizations set status = 'approved', user_id = ${principal.userID},
        project_id = ${body.projectID}, approved_at = now()
      where user_code = ${body.userCode.toUpperCase()} and status = 'pending' and expires_at > now()
      returning id`
    if (!updated) throw new ApiError(404, "device_code_invalid", "This code is invalid or expired")
    await deps.sql`update users set notice_ack_version = ${settings.noticeVersion}, notice_ack_at = now() where id = ${principal.userID}`
    await audit(deps.sql, {
      actor: principal,
      action: "client.project_selected",
      targetType: "project",
      targetID: body.projectID,
      metadata: { via: "device_approval" },
      ip: clientIP(c),
    })
    await checkProjectSwitching(deps, principal.userID, body.projectID)
    return c.json({ ok: true })
  })

  app.post("/api/device/deny", requireAuth, async (c) => {
    const deps = c.get("deps")
    const body = z.object({ userCode: z.string().min(4).max(20) }).parse(await c.req.json())
    await deps.sql`update device_authorizations set status = 'denied' where user_code = ${body.userCode.toUpperCase()} and status = 'pending'`
    return c.json({ ok: true })
  })
}

async function clientPrincipal(deps: Deps, c: Parameters<typeof bearer>[0]): Promise<Principal> {
  const credential = bearer(c)
  if (!credential || credential.via !== "header") throw new ApiError(401, "unauthenticated", "Missing token")
  const principal = await principalFromToken(deps, credential.token)
  if (!principal || principal.sessionKind !== "client") throw new ApiError(401, "unauthenticated", "Session expired or revoked")
  return principal
}

export async function memberProjects(deps: Deps, userID: string) {
  return (await deps.sql`select p.id, p.code, p.name, p.description, p.purpose
    from projects p join project_members m on m.project_id = p.id
    where m.user_id = ${userID} and p.status = 'active'
    order by p.code`) as Array<{ id: string; code: string; name: string; description: string; purpose: string }>
}

export async function remoteConfig(deps: Deps, project: { id: string; code: string; name: string }) {
  const models = await authorizedModels(deps, project.id, "opencode")
  const settings = await orgSettings(deps.sql)
  const prices = await deps.sql`select distinct on (model_id) model_id, currency, input_per_mtok_micros, output_per_mtok_micros,
      cache_read_per_mtok_micros, cache_write_per_mtok_micros
    from pricing_versions where effective_from <= now() order by model_id, effective_from desc, created_at desc`
  const priceByModel = new Map(prices.map((row: { model_id: string }) => [row.model_id, row]))
  const perMillion = (micros: string) => Number(micros) / 1_000_000
  const catalog = (protocol: string) =>
    Object.fromEntries(
      models
        .filter((model) => servesProtocol(model, protocol))
        .map((model) => {
          const price = priceByModel.get(model.id) as Record<string, string> | undefined
          return [
            model.alias,
            {
              name: `${model.display_name} (受管)`,
              modelID: model.alias,
              capabilities: { tools: model.supports_tools, reasoning: { supported: model.supports_reasoning } },
              limit: {
                ...(model.context_limit ? { context: model.context_limit } : {}),
                ...(model.output_limit ? { output: model.output_limit } : {}),
              },
              // OpenCode shows USD estimates only; non-USD prices stay authoritative in Saorsa reports.
              ...(price && price.currency === "USD"
                ? {
                    cost: {
                      input: perMillion(price.input_per_mtok_micros!),
                      output: perMillion(price.output_per_mtok_micros!),
                      cache: { read: perMillion(price.cache_read_per_mtok_micros!), write: perMillion(price.cache_write_per_mtok_micros!) },
                    },
                  }
                : {}),
            },
          ]
        }),
    )
  const anthropic = catalog("anthropic-messages")
  // Provider names carry the billing project, so the OpenCode model picker always shows it.
  const label = `${project.code} ${project.name}`
  return {
    providers: {
      [PROVIDER]: {
        name: `Saorsa · ${label}`,
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `${deps.env.TEAMOS_PUBLIC_URL}/gateway/v1` },
        models: catalog("openai-chat"),
      },
      // Anthropic-protocol models use OpenCode's native Anthropic package so caching and thinking work unchanged.
      ...(Object.keys(anthropic).length
        ? {
            [ANTHROPIC_PROVIDER]: {
              name: `Saorsa Claude · ${label}`,
              package: "@opencode/ai/providers/anthropic",
              settings: { baseURL: `${deps.env.TEAMOS_PUBLIC_URL}/gateway/anthropic/v1` },
              models: anthropic,
            },
          }
        : {}),
    },
    mcp: {
      servers: {
        [MCP_SERVER]: { type: "remote", url: `${deps.env.TEAMOS_PUBLIC_URL}/mcp`, oauth: false, auth: "console" },
      },
    },
    // Statements are evaluated last-match-wins: deny everything, then allow the managed providers.
    policies: settings.restrictToManagedProviders
      ? [
          { action: "provider.use", resource: "*", effect: "deny" },
          { action: "provider.use", resource: PROVIDER, effect: "allow" },
          { action: "provider.use", resource: ANTHROPIC_PROVIDER, effect: "allow" },
        ]
      : [],
  }
}

async function formOrJson(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? ""
  if (type.includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(await request.text()))
  return (await request.json().catch(() => ({}))) as Record<string, unknown>
}
