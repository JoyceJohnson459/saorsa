import type { Hono } from "hono"
import { deleteCookie, setCookie } from "hono/cookie"
import { z } from "zod"
import { ApiError, type AppEnv } from "../context.js"
import {
  WEB_COOKIE,
  clientIP,
  createWebSession,
  hashPassword,
  passwordProblem,
  refreshClientSession,
  requireAuth,
  throttleIP,
  verifyLogin,
} from "../auth.js"
import { safeEqual } from "../crypto.js"
import { audit } from "../audit.js"
import { invalidateSettings, orgSettings } from "../settings.js"

export function authRoutes(app: Hono<AppEnv>) {
  app.get("/api/auth/status", async (c) => {
    const deps = c.get("deps")
    const [row] = await deps.sql`select exists(select 1 from users where account_type = 'ADMIN' and deleted_at is null) as initialized`
    const settings = row.initialized ? await orgSettings(deps.sql) : undefined
    return c.json({ initialized: row.initialized as boolean, organization: settings?.name })
  })

  // One-time initialization guarded by an operator-provided token; closed forever once an admin exists.
  app.post("/api/auth/bootstrap", async (c) => {
    const deps = c.get("deps")
    const body = z
      .object({
        token: z.string(),
        organization: z.string().min(1).max(100),
        timezone: z.string().min(1).max(64).default("Asia/Shanghai"),
        username: z.string().regex(/^[a-zA-Z0-9._-]{3,40}$/),
        displayName: z.string().min(1).max(80),
        email: z.string().email().optional(),
        password: z.string(),
      })
      .parse(await c.req.json())
    await throttleIP(c, "bootstrap", 10)
    const expected = deps.env.TEAMOS_BOOTSTRAP_TOKEN
    if (!expected) throw new ApiError(403, "bootstrap_disabled", "Set SAORSA_BOOTSTRAP_TOKEN on the server to initialize")
    if (!safeEqual(body.token, expected)) {
      await audit(deps.sql, { actorType: "anonymous", action: "auth.bootstrap_failed", ip: clientIP(c) })
      throw new ApiError(403, "bootstrap_token_invalid", "Invalid bootstrap token")
    }
    const problem = passwordProblem(body.password, body.username)
    if (problem) throw new ApiError(422, "weak_password", problem)
    if (!isTimezone(body.timezone)) throw new ApiError(422, "invalid_timezone", "Unknown IANA timezone")
    const passwordHash = await hashPassword(body.password)
    const admin = await deps.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(91823)`
      const [exists] = await tx`select 1 from users where account_type = 'ADMIN' and deleted_at is null`
      if (exists) throw new ApiError(409, "already_initialized", "Saorsa is already initialized")
      await tx`insert into organization (id, name, settings) values (1, ${body.organization}, ${{ timezone: body.timezone }})
        on conflict (id) do update set name = excluded.name, settings = organization.settings || excluded.settings`
      const [user] = await tx`insert into users (username, email, display_name, password_hash, account_type)
        values (${body.username}, ${body.email ?? null}, ${body.displayName}, ${passwordHash}, 'ADMIN') returning id`
      return user.id as string
    })
    invalidateSettings()
    await audit(deps.sql, { actor: { userID: admin, accountType: "ADMIN" }, action: "auth.bootstrap", ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.post("/api/auth/login", async (c) => {
    const deps = c.get("deps")
    const body = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(256) }).parse(await c.req.json())
    const ip = clientIP(c)
    const result = await verifyLogin(deps, body.username, body.password, ip)
    if (!result.ok) {
      await audit(deps.sql, {
        actorType: "anonymous",
        action: "auth.login_failed",
        targetType: "user",
        targetID: result.userID,
        metadata: { reason: result.reason, username: body.username.slice(0, 100) },
        ip,
      })
      if (result.reason === "locked") throw new ApiError(423, "account_locked", "Too many failed attempts; account locked for 15 minutes")
      // Disabled and unknown accounts share one message so usernames cannot be enumerated.
      throw new ApiError(401, "invalid_credentials", "Invalid username or password")
    }
    const session = await createWebSession(deps, result.user.id, { userAgent: c.req.header("user-agent")?.slice(0, 256), ip })
    setCookie(c, WEB_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "Strict",
      secure: deps.env.TEAMOS_COOKIE_SECURE ?? deps.env.TEAMOS_PUBLIC_URL.startsWith("https://"),
      path: "/",
      expires: session.expires,
    })
    await audit(deps.sql, { actor: { userID: result.user.id, accountType: result.user.accountType }, action: "auth.login", ip })
    return c.json({ user: result.user })
  })

  app.post("/api/auth/logout", requireAuth, async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    await deps.sql`update user_sessions set revoked_at = now(), revoke_reason = 'logout' where id = ${principal.sessionID} and revoked_at is null`
    deleteCookie(c, WEB_COOKIE, { path: "/" })
    await audit(deps.sql, { actor: principal, action: "auth.logout", ip: clientIP(c) })
    return c.json({ ok: true })
  })

  // Token rotation for OpenCode client sessions (same semantics as the device-flow refresh grant).
  app.post("/api/auth/refresh", async (c) => {
    const body = z.object({ refreshToken: z.string().min(10) }).parse(await c.req.json())
    const rotated = await refreshClientSession(c.get("deps"), body.refreshToken)
    if (!rotated) throw new ApiError(401, "invalid_grant", "Refresh token is invalid, expired or revoked")
    return c.json({ accessToken: rotated.access, refreshToken: rotated.refresh, expiresIn: rotated.expiresIn, projectID: rotated.projectID })
  })

  app.get("/api/me", requireAuth, async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const [user] = await deps.sql`select id, username, email, display_name, account_type, must_change_password, notice_ack_version,
        last_login_at, created_at from users where id = ${principal.userID}`
    const settings = await orgSettings(deps.sql)
    return c.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.display_name,
        accountType: user.account_type,
        mustChangePassword: user.must_change_password,
        lastLoginAt: user.last_login_at,
        createdAt: user.created_at,
      },
      organization: settings.name,
      notice: { version: settings.noticeVersion, acknowledged: user.notice_ack_version === settings.noticeVersion },
      session: { id: principal.sessionID, kind: principal.sessionKind, projectID: principal.projectID },
    })
  })

  app.post("/api/me/password", requireAuth, async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const body = z.object({ current: z.string().min(1), next: z.string() }).parse(await c.req.json())
    const result = await verifyLogin(deps, principal.username, body.current, clientIP(c))
    if (!result.ok) throw new ApiError(403, "invalid_credentials", "Current password is incorrect")
    const problem = passwordProblem(body.next, principal.username)
    if (problem) throw new ApiError(422, "weak_password", problem)
    await deps.sql`update users set password_hash = ${await hashPassword(body.next)}, must_change_password = false, updated_at = now()
      where id = ${principal.userID}`
    // Changing the password signs out every other session, including OpenCode clients.
    await deps.sql`update user_sessions set revoked_at = now(), revoke_reason = 'password_changed'
      where user_id = ${principal.userID} and id <> ${principal.sessionID} and revoked_at is null`
    await audit(deps.sql, { actor: principal, action: "auth.password_changed", ip: clientIP(c) })
    return c.json({ ok: true })
  })

  app.post("/api/me/notice-ack", requireAuth, async (c) => {
    const deps = c.get("deps")
    const principal = c.get("principal")
    const settings = await orgSettings(deps.sql)
    await deps.sql`update users set notice_ack_version = ${settings.noticeVersion}, notice_ack_at = now() where id = ${principal.userID}`
    await audit(deps.sql, { actor: principal, action: "notice.acknowledged", metadata: { version: settings.noticeVersion } })
    return c.json({ ok: true })
  })

  app.get("/api/notice", async (c) => {
    const settings = await orgSettings(c.get("deps").sql)
    return c.json({ version: settings.noticeVersion, text: settings.noticeText })
  })
}

function isTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value })
    return true
  } catch {
    return false
  }
}
