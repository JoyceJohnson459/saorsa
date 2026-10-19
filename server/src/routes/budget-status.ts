import type { Deps } from "../context.js"
import { num } from "../db.js"
import { orgSettings } from "../settings.js"

/**
 * Current-period spend for budgets. Members see only budgets scoped to themselves (user and user-project).
 * The month-end projection is a linear extrapolation and always labelled as a forecast.
 */
export async function budgetStatus(deps: Deps, scope: { userID?: string }) {
  const settings = await orgSettings(deps.sql)
  const rows = await deps.sql`select b.id, b.scope_type, b.project_id, b.user_id, b.model_id, b.period, b.limit_micros, b.currency,
      b.warn_thresholds, b.hard_limit, b.per_request_max_micros, b.enabled,
      p.code as project_code, p.name as project_name, u.username, u.display_name, m.alias as model_alias,
      ps.period_start,
      coalesce(c.spent_micros, 0) as spent_micros, coalesce(c.reserved_micros, 0) as reserved_micros,
      coalesce((select sum(a.delta_micros) from budget_adjustments a where a.budget_id = b.id and a.kind = 'temporary_raise'
        and a.created_at >= ps.period_start and (a.expires_at is null or a.expires_at > now())), 0) as raise_micros
    from budgets b
    cross join lateral (select case b.period
        when 'daily' then date_trunc('day', now(), ${settings.timezone})
        when 'monthly' then date_trunc('month', now(), ${settings.timezone})
        else timestamptz '1970-01-01 00:00:00+00' end as period_start) ps
    left join budget_counters c on c.budget_id = b.id and c.period_start = ps.period_start
    left join projects p on p.id = b.project_id
    left join users u on u.id = b.user_id
    left join models m on m.id = b.model_id
    where (${scope.userID ?? null}::uuid is null or (b.user_id = ${scope.userID ?? null} and b.scope_type in ('user', 'user_project')))
    order by b.scope_type, b.created_at`
  const now = Date.now()
  return rows.map((row: Record<string, unknown>) => {
    const limit = num(row.limit_micros) + num(row.raise_micros)
    const spent = num(row.spent_micros)
    const start = new Date(row.period_start as Date).getTime()
    const elapsedDays = Math.max((now - start) / 86400_000, 1 / 24)
    const end = row.period === "monthly" ? new Date(new Date(start).setMonth(new Date(start).getMonth() + 1)).getTime() : start + 86400_000
    const totalDays = (end - start) / 86400_000
    return {
      ...row,
      limit_micros: num(row.limit_micros),
      raise_micros: num(row.raise_micros),
      effective_limit_micros: limit,
      spent_micros: spent,
      reserved_micros: num(row.reserved_micros),
      per_request_max_micros: row.per_request_max_micros === null ? null : num(row.per_request_max_micros),
      percent: limit > 0 ? Math.round((spent / limit) * 1000) / 10 : null,
      forecast_micros: row.period === "total" ? null : Math.round((spent / elapsedDays) * totalDays),
      forecast_label: "linear forecast (not a bill)",
    }
  })
}
