import type { TransactionSQL } from "bun"
import { ApiError, type Deps } from "./context.js"
import type { Sql } from "./db.js"
import { orgSettings } from "./settings.js"

/**
 * Exclusive key assignment, first come first served. A member's first request for a provider's model claims
 * one of that provider's free keys; while the member keeps working the key serves nobody else. Using a model
 * of another provider moves the member to a free key there (only if one is free). A key returns to the pool
 * when its holder releases it, stays idle for `keyLeaseIdleMinutes`, has no OpenCode login left, is disabled,
 * or when its key is revoked.
 */
export async function claimKey(deps: Deps, userID: string, providerID: string, exclude: ReadonlySet<string> = new Set()) {
  const settings = await orgSettings(deps.sql)
  const claim = await deps.sql.begin(async (tx) => {
    // Serializes one member's parallel requests so they never claim two keys.
    await tx`select id from users where id = ${userID} for update`
    const swept = await sweep(tx, settings.keyLeaseIdleMinutes)
    const [held] = await tx`select l.credential_id, l.provider_id, c.ciphertext, c.nonce, c.key_version,
        (c.cooldown_until is null or c.cooldown_until < now()) as usable
      from credential_leases l join provider_credentials c on c.id = l.credential_id
      where l.user_id = ${userID}`
    if (held && held.provider_id === providerID && held.usable && !exclude.has(held.credential_id)) {
      await tx`update credential_leases set last_used_at = now() where credential_id = ${held.credential_id}`
      return { credential: credentialOf(held), changed: swept > 0 }
    }
    const skip = [...exclude, ...(held ? [held.credential_id as string] : [])]
    const [free] = await tx`select c.id, c.ciphertext, c.nonce, c.key_version from provider_credentials c
      where c.provider_id = ${providerID} and c.status = 'active' and (c.cooldown_until is null or c.cooldown_until < now())
        and c.id <> all(${deps.sql.array(skip, "uuid")}::uuid[])
        and not exists (select 1 from credential_leases l where l.credential_id = c.id)
      order by c.priority asc, c.last_used_at asc nulls first
      limit 1 for update of c skip locked`
    if (!free) return { credential: undefined, changed: swept > 0 }
    await tx`delete from credential_leases where user_id = ${userID}`
    const [claimed] = await tx`insert into credential_leases (credential_id, provider_id, user_id)
      values (${free.id}, ${providerID}, ${userID}) on conflict (credential_id) do nothing returning credential_id`
    return { credential: claimed ? credentialOf({ credential_id: free.id, ...free }) : undefined, changed: true }
  })
  if (claim.changed) await announce(deps)
  return claim.credential
}

export async function releaseKey(deps: Deps, filter: { userID: string } | { credentialID: string }) {
  const rows =
    "userID" in filter
      ? await deps.sql`delete from credential_leases where user_id = ${filter.userID} returning credential_id, user_id`
      : await deps.sql`delete from credential_leases where credential_id = ${filter.credentialID} returning credential_id, user_id`
  if (rows.length) await announce(deps)
  return rows[0] as { credential_id: string; user_id: string } | undefined
}

/** Per-provider key availability, after expiring idle leases. `mine` marks the provider whose key the user holds. */
export async function keyPools(deps: Deps, userID?: string) {
  const settings = await orgSettings(deps.sql)
  if ((await sweep(deps.sql, settings.keyLeaseIdleMinutes)) > 0) await announce(deps)
  const rows = await deps.sql`select p.id, p.name, p.protocol,
      count(c.id)::int as total,
      count(c.id) filter (where l.credential_id is null and (c.cooldown_until is null or c.cooldown_until < now()))::int as free,
      coalesce(bool_or(l.user_id = ${userID ?? null}::uuid), false) as mine
    from providers p
    left join provider_credentials c on c.provider_id = p.id and c.status = 'active'
    left join credential_leases l on l.credential_id = c.id
    where p.enabled
    group by p.id order by p.priority, p.name`
  return rows as Array<{ id: string; name: string; protocol: string; total: number; free: number; mine: boolean }>
}

/** The member-facing rejection when every key of the requested provider is held by someone else. */
export async function noFreeKey(deps: Deps, providerID: string, projectID: string) {
  const pools = await keyPools(deps)
  const allowed = await deps.sql`select distinct m.provider_id from models m
    join model_permissions mp on mp.model_id = m.id and mp.project_id = ${projectID} and mp.allowed where m.enabled`
  const allowedProviderIDs = allowed.map((row: { provider_id: string }) => row.provider_id)
  const wanted = pools.find((pool) => pool.id === providerID)
  const others = pools.filter((pool) => pool.id !== providerID && pool.free > 0 && allowedProviderIDs.includes(pool.id))
  const advice = others.length
    ? `当前有空闲 Key 的模型：${others.map((pool) => `${pool.name}(${pool.free})`).join("、")}，可在 OpenCode 中切换到这些模型`
    : "请稍后再试，或联系管理员增加 Key"
  return new ApiError(
    429,
    "no_free_key",
    `${wanted?.name ?? "该模型"} 的 ${wanted?.total ?? 0} 个 Key 都在被其他成员使用。${advice}。（All keys of this provider are in use.）`,
    { retryable: false },
  )
}

/** An unheld key for organization overhead (the relevance classifier), so it never shares a member's key. */
export async function freeCredential(sql: Sql, providerID: string) {
  const [row] = await sql`select c.id, c.ciphertext, c.nonce, c.key_version from provider_credentials c
    where c.provider_id = ${providerID} and c.status = 'active' and (c.cooldown_until is null or c.cooldown_until < now())
      and not exists (select 1 from credential_leases l where l.credential_id = c.id)
    order by c.priority asc, c.last_used_at asc nulls first limit 1`
  return row as { id: string; ciphertext: Uint8Array; nonce: Uint8Array; key_version: number } | undefined
}

async function sweep(sql: Sql | TransactionSQL, idleMinutes: number) {
  // A lease whose holder still has a request in flight is never expired, however long the stream runs.
  const rows = await sql`delete from credential_leases l
    where (l.last_used_at < now() - make_interval(mins => ${idleMinutes})
        and not exists (select 1 from gateway_requests r where r.user_id = l.user_id and r.status in ('pending', 'streaming')
          and r.started_at > now() - interval '2 hours'))
      or not exists (select 1 from provider_credentials c where c.id = l.credential_id and c.status = 'active')
      or not exists (select 1 from users u where u.id = l.user_id and u.status = 'active' and u.deleted_at is null)
      or not exists (select 1 from user_sessions s where s.user_id = l.user_id and s.kind = 'client'
        and s.revoked_at is null and s.expires_at > now())
    returning credential_id`
  return rows.length
}

function credentialOf(row: { credential_id: string; ciphertext: Uint8Array; nonce: Uint8Array; key_version: number }) {
  return { id: row.credential_id, ciphertext: row.ciphertext, nonce: row.nonce, key_version: row.key_version }
}

/** Key pickers in every console refresh on this event; it carries no member data. */
async function announce(deps: Deps) {
  await deps.realtime.publish({ type: "key.lease", data: {} })
}
