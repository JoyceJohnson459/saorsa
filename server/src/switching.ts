import type { Deps } from "./context.js"
import { loadRules, recordRisk } from "./risk.js"

/** Frequent billing-project changes can indicate cost shifting between project budgets. Review-only. */
export async function checkProjectSwitching(deps: Deps, userID: string, projectID: string) {
  const rule = (await loadRules(deps.sql)).get("project_switching")
  if (!rule?.enabled) return
  const windowHours = Number(rule.config.window_hours ?? 24)
  const max = Number(rule.config.max_switches ?? 6)
  const rows = await deps.sql`select target_id from audit_logs
    where actor_user_id = ${userID} and action in ('client.project_selected', 'client.project_switched')
      and created_at > now() - make_interval(hours => ${windowHours})
    order by created_at`
  const switches = rows.reduce(
    (state: { last?: string; count: number }, row: { target_id: string }) => ({
      last: row.target_id,
      count: state.last !== undefined && state.last !== row.target_id ? state.count + 1 : state.count,
    }),
    { count: 0 },
  ).count
  if (switches <= max) return
  const bucket = Math.floor(Date.now() / (windowHours * 3600_000))
  await recordRisk(deps, {
    userID,
    projectID,
    category: "attribution_switching",
    severity: "review",
    confidence: 0.5,
    detector: "rule:project_switching",
    summary: `Billing project changed ${switches} times within ${windowHours}h (threshold ${max}).`,
    evidence: {
      rule: "project_switching",
      switches,
      window_hours: windowHours,
      threshold: max,
      explanation: "Counted from the member's own project selection audit records. Members on several projects may switch legitimately.",
    },
    dedupeKey: `switching:${userID}:${bucket}`,
  })
}
