import type { Context, MiddlewareHandler } from "hono"
import { getCookie } from "hono/cookie"
import { getConnInfo } from "hono/bun"
import { ApiError, type AppEnv, type Deps, type Principal } from "./context.js"
import { randomToken, sha256 } from "./crypto.js"
import { orgSettings } from "./settings.js"

export const WEB_COOKIE = "teamos_session"
const MAX_FAILED_LOGINS = 5
const LOCK_MINUTES = 15

export async function hashPassword(password: string) {
  return Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 65536, timeCost: 3 })
}

export function passwordProblem(password: string, username?: string) {
  if (password.length < 12) return "Password must be at least 12 characters"
  if (password.length > 256) return "Password is too long"
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length
  if (classes < 3) return "Password must mix at least three of: lowercase, uppercase, digits, symbols"
  if (username && password.toLowerCase().includes(username.toLowerCase())) return "Password must not contain the username"
  if (/^(.)\1+$/.test(password) || /password|123456|qwerty|admin/i.test(password)) return "Password is too common"
  return undefined
}

/** Constant-ish time login: unknown users still pay for one hash verification. */
const decoyHash = await hashPassword(randomToken("decoy"))

export async function verifyLogin(deps: Deps, username: string, password: string, ip: string) {
  const ipKey = `teamos:login:ip:${ip}`
  const attempts = await deps.redis.incr(ipKey)
  if (attempts === 1) await deps.redis.expire(ipKey, 60)
  if (attempts > 20) throw new ApiError(429, "rate_limited", "Too many login attempts, try again in a minute")

  const [user] = await deps.sql`select id, username, display_name, password_hash, account_type, status, locked_until,
      failed_logins, must_change_password
    from users where lower(username) = lower(${username}) and deleted_at is null`
  if (!user) {
    await Bun.password.verify(password, decoyHash)
    return { ok: false as const, reason: "invalid_credentials", userID: undefined }
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return { ok: false as const, reason: "locked", userID: user.id as string }
  }
  const valid = await Bun.password.verify(password, user.password_hash)
  if (!valid) {
    await deps.sql`update users set failed_logins = failed_logins + 1,
        locked_until = case when failed_logins + 1 >= ${MAX_FAILED_LOGINS}
          then now() + make_interval(mins => ${LOCK_MINUTES}) else locked_until end
      where id = ${user.id}`
    return { ok: false as const, reason: "invalid_credentials", userID: user.id as string }
  }
  if (user.status !== "active") return { ok: false as const, reason: "disabled", userID: user.id as string }
  await deps.sql`update users set failed_logins = 0, locked_until = null, last_login_at = now() where id = ${user.id}`
  return {
    ok: true as const,
    user: {
      id: user.id as string,
      username: user.username as string,
      displayName: user.display_name as string,
      accountType: user.account_type as "ADMIN" | "MEMBER",
      mustChangePassword: user.must_change_password as boolean,
    },
  }
}

export async function createWebSession(deps: Deps, userID: string, meta: { userAgent?: string; ip?: string }) {
  const token = randomToken("tos_web")
  const expires = new Date(Date.now() + deps.env.TEAMOS_WEB_SESSION_TTL_HOURS * 3600_000)
  const [row] = await deps.sql`insert into user_sessions (user_id, kind, access_token_hash, access_expires_at, expires_at, user_agent, ip, device_label)
    values (${userID}, 'web', ${sha256(token)}, ${expires}, ${expires}, ${meta.userAgent ?? null}, ${meta.ip ?? null}, 'Web console')
    returning id`
  await replaceOtherSessions(deps, userID, "web", null, row.id)
  return { token, expires, sessionID: row.id as string }
}

export async function createClientSession(
  deps: Deps,
  input: { userID: string; projectID: string; deviceLabel?: string; userAgent?: string; ip?: string },
) {
  // The OpenCode console device flow is the only refresh-token client; every other tool uses token sessions.
  const access = randomToken("tos_at")
  const refresh = randomToken("tos_rt")
  const accessExpires = new Date(Date.now() + deps.env.TEAMOS_ACCESS_TOKEN_TTL_SECONDS * 1000)
  const expires = new Date(Date.now() + deps.env.TEAMOS_CLIENT_SESSION_TTL_DAYS * 86400_000)
  const [row] = await deps.sql`insert into user_sessions (user_id, kind, project_id, tool_id, access_token_hash, access_expires_at,
      refresh_token_hash, expires_at, device_label, user_agent, ip)
    values (${input.userID}, 'client', ${input.projectID}, 'opencode', ${sha256(access)}, ${accessExpires}, ${sha256(refresh)}, ${expires},
      ${input.deviceLabel ?? "OpenCode"}, ${input.userAgent ?? null}, ${input.ip ?? null})
    returning id`
  await replaceOtherSessions(deps, input.userID, "client", "opencode", row.id)
  return { access, refresh, expiresIn: deps.env.TEAMOS_ACCESS_TOKEN_TTL_SECONDS, sessionID: row.id as string }
}

/**
 * Token session bound to one project and one tool: OpenCode 1.x well-known logins and member tool keys pasted
 * into IDE settings slide forward while used (see touchClientSession); tokens a Launcher hands to a child
 * process are short-lived (`ttlHours`), never slide, and end with their parent Launcher session. All are
 * hashed at rest and revoked instantly by logout, disable, reset or admin action.
 */
export async function createTokenSession(
  deps: Deps,
  input: {
    userID: string
    projectID: string
    toolID?: string
    deviceLabel?: string
    userAgent?: string
    ip?: string
    parentSessionID?: string
    ttlHours?: number
  },
) {
  const access = randomToken("tos_at")
  const toolID = input.toolID ?? "opencode"
  const expires = new Date(Date.now() + (input.ttlHours ? input.ttlHours * 3600_000 : deps.env.TEAMOS_CLIENT_SESSION_TTL_DAYS * 86400_000))
  const [row] = await deps.sql`insert into user_sessions (user_id, kind, project_id, tool_id, parent_session_id, access_token_hash,
      access_expires_at, expires_at, device_label, user_agent, ip)
    values (${input.userID}, 'client', ${input.projectID}, ${toolID}, ${input.parentSessionID ?? null}, ${sha256(access)}, ${expires},
      ${expires}, ${input.deviceLabel ?? "OpenCode"}, ${input.userAgent ?? null}, ${input.ip ?? null})
    returning id`
  // A Launcher already replaced its other devices when it signed in; its per-launch tokens coexist.
  if (!input.parentSessionID) await replaceOtherSessions(deps, input.userID, "client", toolID, row.id)
  return { access, sessionID: row.id as string, expiresAt: expires }
}

/** A signed-in Saorsa Launcher on one device. Tool tokens it requests are children of this session. */
export async function createLauncherSession(
  deps: Deps,
  input: { userID: string; deviceID: string; deviceLabel: string; userAgent?: string; ip?: string },
) {
  const access = randomToken("tos_at")
  const expires = new Date(Date.now() + deps.env.TEAMOS_CLIENT_SESSION_TTL_DAYS * 86400_000)
  const [row] = await deps.sql`insert into user_sessions (user_id, kind, device_id, access_token_hash, access_expires_at, expires_at,
      device_label, user_agent, ip)
    values (${input.userID}, 'launcher', ${input.deviceID}, ${sha256(access)}, ${expires}, ${expires}, ${input.deviceLabel},
      ${input.userAgent ?? null}, ${input.ip ?? null})
    returning id`
  await replaceOtherSessions(deps, input.userID, "launcher", null, row.id)
  return { access, sessionID: row.id as string }
}

/**
 * Records use of a session. Long-lived token sessions (no refresh token, no parent Launcher) get their idle
 * expiry extended; short-lived Launcher tool tokens keep their fixed expiry.
 */
export async function touchClientSession(deps: Deps, sessionID: string) {
  await deps.sql`update user_sessions set last_used_at = now(),
      access_expires_at = case when refresh_token_hash is null and parent_session_id is null
        then greatest(access_expires_at, now() + make_interval(days => ${deps.env.TEAMOS_CLIENT_SESSION_TTL_DAYS})) else access_expires_at end,
      expires_at = case when refresh_token_hash is null and parent_session_id is null
        then greatest(expires_at, now() + make_interval(days => ${deps.env.TEAMOS_CLIENT_SESSION_TTL_DAYS})) else expires_at end
    where id = ${sessionID}`
}

/**
 * Rotates a client refresh token. Presenting the previous (already rotated) token means it leaked or a
 * replay happened, so the whole session is revoked rather than issuing yet another token pair.
 */
export async function refreshClientSession(deps: Deps, refreshToken: string) {
  const hash = sha256(refreshToken)
  return deps.sql.begin(async (tx) => {
    const [session] = await tx`select s.id, s.user_id, s.project_id, s.expires_at, s.revoked_at, s.refresh_token_hash,
        u.status as user_status
      from user_sessions s join users u on u.id = s.user_id
      where s.kind = 'client' and (s.refresh_token_hash = ${hash} or s.previous_refresh_token_hash = ${hash})
      for update of s`
    if (!session) return undefined
    if (session.refresh_token_hash !== hash) {
      await tx`update user_sessions set revoked_at = coalesce(revoked_at, now()), revoke_reason = coalesce(revoke_reason, 'refresh_token_reuse')
        where id = ${session.id}`
      return undefined
    }
    if (session.revoked_at || new Date(session.expires_at) < new Date() || session.user_status !== "active") return undefined
    const access = randomToken("tos_at")
    const refresh = randomToken("tos_rt")
    const accessExpires = new Date(Date.now() + deps.env.TEAMOS_ACCESS_TOKEN_TTL_SECONDS * 1000)
    await tx`update user_sessions set access_token_hash = ${sha256(access)}, access_expires_at = ${accessExpires},
        previous_refresh_token_hash = refresh_token_hash, refresh_token_hash = ${sha256(refresh)}, last_used_at = now()
      where id = ${session.id}`
    return {
      access,
      refresh,
      expiresIn: deps.env.TEAMOS_ACCESS_TOKEN_TTL_SECONDS,
      sessionID: session.id as string,
      projectID: session.project_id as string,
      userID: session.user_id as string,
    }
  })
}

export function bearer(c: Context) {
  const header = c.req.header("authorization")
  if (header?.toLowerCase().startsWith("bearer ")) return { token: header.slice(7).trim(), via: "header" as const }
  // Anthropic-protocol clients authenticate with x-api-key, Gemini clients with x-goog-api-key.
  const apiKey = c.req.header("x-api-key") ?? c.req.header("x-goog-api-key")
  if (apiKey) return { token: apiKey.trim(), via: "header" as const }
  const cookie = getCookie(c, WEB_COOKIE)
  if (cookie) return { token: cookie, via: "cookie" as const }
  return undefined
}

export async function principalFromToken(deps: Deps, token: string): Promise<Principal | undefined> {
  // A Launcher tool token ends with the Launcher session that issued it.
  const [row] = await deps.sql`select s.id as session_id, s.kind, s.project_id, s.tool_id, s.device_id, s.access_expires_at, s.expires_at,
      u.id as user_id, u.username, u.display_name, u.account_type
    from user_sessions s join users u on u.id = s.user_id
    where s.access_token_hash = ${sha256(token)} and s.revoked_at is null and u.status = 'active' and u.deleted_at is null
      and (s.parent_session_id is null or exists (select 1 from user_sessions p where p.id = s.parent_session_id
        and p.revoked_at is null and p.expires_at > now()))`
  if (!row) return undefined
  const now = new Date()
  if (new Date(row.access_expires_at) < now || new Date(row.expires_at) < now) return undefined
  return {
    userID: row.user_id,
    username: row.username,
    displayName: row.display_name,
    accountType: row.account_type,
    sessionID: row.session_id,
    sessionKind: row.kind,
    projectID: row.project_id ?? undefined,
    toolID: row.tool_id ?? undefined,
    deviceID: row.device_id ?? undefined,
  }
}

/**
 * Single-device login, per channel: a new web login signs out the member's other browsers; a new Launcher
 * login signs out the Launcher (and every tool token it issued) on other devices; a new login of one tool
 * (OpenCode, an IDE key) signs out that tool elsewhere. Channels stay independent, so approving a login in
 * the browser never ends the session it creates and different tools on one machine coexist. Open consoles
 * are told immediately over SSE.
 */
async function replaceOtherSessions(deps: Deps, userID: string, kind: "web" | "client" | "launcher", toolID: string | null, keepID: string) {
  if (!(await orgSettings(deps.sql)).singleDeviceLogin) return
  const replaced = await deps.sql`update user_sessions set revoked_at = now(), revoke_reason = 'replaced'
    where user_id = ${userID} and kind = ${kind} and tool_id is not distinct from ${toolID} and id <> ${keepID}
      and parent_session_id is null and revoked_at is null returning id`
  if (replaced.length)
    await deps.realtime.publish({ type: "session.ended", userID, data: { sessionIDs: replaced.map((row: { id: string }) => row.id), reason: "replaced" } })
}

/** Why a token stopped working, so clients can say "signed in on another device" instead of "expired". */
export async function endedReason(deps: Deps, token: string) {
  const [row] = await deps.sql`select revoke_reason from user_sessions where access_token_hash = ${sha256(token)}`
  return row?.revoke_reason === "replaced" ? ("replaced" as const) : undefined
}

/** Authenticates every request; cookie-authenticated writes must also carry the CSRF header. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const credential = bearer(c)
  if (!credential) throw new ApiError(401, "unauthenticated", "Sign in required")
  const principal = await principalFromToken(c.get("deps"), credential.token)
  if (!principal) {
    if (await endedReason(c.get("deps"), credential.token))
      throw new ApiError(401, "session_replaced", "账号已在其他设备登录，本设备已退出（signed in on another device）")
    throw new ApiError(401, "unauthenticated", "Session expired or revoked")
  }
  if (credential.via === "cookie" && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    if (c.req.header("x-teamos-csrf") !== "1") throw new ApiError(403, "csrf", "Missing CSRF header")
  }
  c.set("principal", principal)
  await next()
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("principal").accountType !== "ADMIN") throw new ApiError(403, "forbidden", "Administrator access required")
  await next()
}

/** Per-IP throttle for unauthenticated endpoints (device codes, bootstrap), shared across replicas. */
export async function throttleIP(c: Context<AppEnv>, bucket: string, perMinute: number) {
  await c.get("deps").limiter.admit({
    requests: [{ scope: `ip:${bucket}:${clientIP(c)}`, limit: perMinute, label: "requests from your address" }],
    tokens: [],
    estimatedTokens: 0,
  })
}

export function clientIP(c: Context<AppEnv>) {
  // X-Forwarded-For is client-controlled unless a reverse proxy overwrites it, so it is opt-in.
  if (c.get("deps").env.TEAMOS_TRUST_PROXY) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    if (forwarded) return forwarded
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown"
  } catch {
    return "unknown"
  }
}
