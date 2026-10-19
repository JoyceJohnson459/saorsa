import type { Deps } from "./context.js"
import { release } from "./budget.js"
import { orgSettings } from "./settings.js"

/**
 * Periodic housekeeping, serialized across replicas by an advisory lock:
 * - requests stuck in pending/streaming (process died mid-request) are closed and their reservations released,
 *   with billing marked unknown rather than guessed;
 * - expired device codes are closed;
 * - request details, notifications and risk evidence past the retention window are removed.
 */
export async function runMaintenance(deps: Deps) {
  const settings = await orgSettings(deps.sql)
  return deps.sql.begin(async (tx) => {
    const [lock] = await tx`select pg_try_advisory_xact_lock(55120) as ok`
    if (!lock.ok) return undefined
    const stale = await tx`update gateway_requests set status = 'failed', error_code = 'gateway_interrupted',
        error_message = 'Gateway process stopped before the request finished; usage unknown', billing_status = 'unknown', ended_at = now()
      where status in ('pending', 'streaming') and started_at < now() - interval '30 minutes'
      returning id`
    for (const row of stale) await release(tx, row.id)
    await tx`update device_authorizations set status = 'expired' where status = 'pending' and expires_at < now()`
    await tx`delete from device_authorizations where created_at < now() - interval '7 days'`
    await tx`delete from notifications where read_at is not null and created_at < now() - interval '180 days'`
    // Risk evidence is cleared (not the event row) so review history and counts survive the retention window.
    const scrubbed = await tx`update risk_events set evidence = '{"retention":"evidence removed after retention period"}'::jsonb
      where created_at < now() - make_interval(days => ${settings.riskRetentionDays}) and evidence ? 'excerpt_redacted'
      returning id`
    // Ledger and aggregate counters are kept for accounting; only per-request identifying details expire.
    const minimized = await tx`update gateway_requests set client_ip = null, user_agent = null, error_message = null,
        opencode_session_id = null
      where started_at < now() - make_interval(days => ${settings.requestRetentionDays})
        and (client_ip is not null or user_agent is not null or opencode_session_id is not null)
      returning id`
    return { staleRequests: stale.length, scrubbedRiskEvidence: scrubbed.length, minimizedRequests: minimized.length }
  })
}

export function startMaintenance(deps: Deps) {
  const timer = setInterval(() => {
    runMaintenance(deps).catch((cause) => deps.log.warn("maintenance failed", { cause: String(cause) }))
  }, 60_000)
  return () => clearInterval(timer)
}
