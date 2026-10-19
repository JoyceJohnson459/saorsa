import type { TransactionSQL } from "bun"
import { ApiError } from "./context.js"
import { formatMoney } from "./pricing.js"

type Tx = TransactionSQL

export interface BudgetScope {
  userID: string
  projectID: string
  modelID: string
}

interface LockedBudget {
  id: string
  scope_type: string
  period: string
  limit_micros: string
  currency: string
  hard_limit: boolean
  per_request_max_micros: string | null
  warn_thresholds: number[]
  period_start: Date
  spent_micros: string
  reserved_micros: string
  last_alert_threshold: number
  raise_micros: string
}

/**
 * Locks every budget that applies to the request (ordered by id to avoid deadlocks between concurrent
 * requests) and returns their current counters plus active temporary raises.
 */
async function lockBudgets(tx: Tx, scope: BudgetScope, timezone: string): Promise<LockedBudget[]> {
  const budgets = await tx`select b.id, b.period,
      case b.period
        when 'daily' then date_trunc('day', now(), ${timezone})
        when 'monthly' then date_trunc('month', now(), ${timezone})
        else timestamptz '1970-01-01 00:00:00+00'
      end as period_start
    from budgets b
    where b.enabled and (
      b.scope_type = 'org'
      or (b.scope_type = 'project' and b.project_id = ${scope.projectID})
      or (b.scope_type = 'user' and b.user_id = ${scope.userID})
      or (b.scope_type = 'user_project' and b.user_id = ${scope.userID} and b.project_id = ${scope.projectID})
      or (b.scope_type = 'model' and b.model_id = ${scope.modelID})
    )
    order by b.id`
  if (budgets.length === 0) return []
  for (const budget of budgets) {
    await tx`insert into budget_counters (budget_id, period_start) values (${budget.id}, ${budget.period_start})
      on conflict do nothing`
  }
  const locked: LockedBudget[] = []
  for (const budget of budgets) {
    const [row] = await tx`select b.id, b.scope_type, b.period, b.limit_micros, b.currency, b.hard_limit, b.per_request_max_micros,
        b.warn_thresholds, c.period_start, c.spent_micros, c.reserved_micros, c.last_alert_threshold,
        coalesce((select sum(a.delta_micros) from budget_adjustments a
          where a.budget_id = b.id and a.kind = 'temporary_raise' and a.created_at >= c.period_start
            and (a.expires_at is null or a.expires_at > now())), 0) as raise_micros
      from budget_counters c join budgets b on b.id = c.budget_id
      where c.budget_id = ${budget.id} and c.period_start = ${budget.period_start}
      for update of c`
    locked.push(row as LockedBudget)
  }
  return locked
}

export async function reserve(
  tx: Tx,
  input: BudgetScope & { requestUUID: string; estimateMicros: bigint; timezone: string },
) {
  const budgets = await lockBudgets(tx, input, input.timezone)
  for (const budget of budgets) {
    const limit = BigInt(budget.limit_micros) + BigInt(budget.raise_micros)
    const committed = BigInt(budget.spent_micros) + BigInt(budget.reserved_micros)
    if (budget.per_request_max_micros !== null && input.estimateMicros > BigInt(budget.per_request_max_micros)) {
      throw new ApiError(
        402,
        "request_budget_exceeded",
        `This request could cost up to ${formatMoney(input.estimateMicros, budget.currency)}, above the ${scopeLabel(budget)} per-request limit of ${formatMoney(BigInt(budget.per_request_max_micros), budget.currency)}. Reduce the context or max output tokens.`,
      )
    }
    if (budget.hard_limit && committed + input.estimateMicros > limit) {
      throw new ApiError(
        402,
        "budget_exceeded",
        `${capitalize(scopeLabel(budget))} ${budget.period} budget exhausted: ${formatMoney(BigInt(budget.spent_micros), budget.currency)} spent of ${formatMoney(limit, budget.currency)} (${formatMoney(BigInt(budget.reserved_micros), budget.currency)} reserved by in-flight requests). Ask an administrator to raise the limit.`,
      )
    }
  }
  for (const budget of budgets) {
    await tx`update budget_counters set reserved_micros = reserved_micros + ${input.estimateMicros.toString()}::bigint
      where budget_id = ${budget.id} and period_start = ${budget.period_start}`
    await tx`insert into budget_reservations (request_id, budget_id, period_start, reserved_micros)
      values (${input.requestUUID}, ${budget.id}, ${budget.period_start}, ${input.estimateMicros.toString()}::bigint)`
  }
  return budgets.length
}

export interface CrossedThreshold {
  budgetID: string
  scopeType: string
  period: string
  threshold: number
  spentMicros: bigint
  limitMicros: bigint
  currency: string
}

/**
 * Converts reservations into actual spend. Runs in the same transaction that writes the usage ledger,
 * so spend counters and ledger can never disagree. Returns thresholds newly crossed for alerting.
 */
export async function settle(tx: Tx, requestUUID: string, actualMicros: bigint) {
  const reservations = await tx`select r.id, r.budget_id, r.period_start, r.reserved_micros
    from budget_reservations r where r.request_id = ${requestUUID} and r.status = 'reserved'
    order by r.budget_id for update`
  const crossed: CrossedThreshold[] = []
  for (const reservation of reservations) {
    const [counter] = await tx`update budget_counters set
        reserved_micros = greatest(0, reserved_micros - ${reservation.reserved_micros}::bigint),
        spent_micros = spent_micros + ${actualMicros.toString()}::bigint
      where budget_id = ${reservation.budget_id} and period_start = ${reservation.period_start}
      returning spent_micros, last_alert_threshold`
    await tx`update budget_reservations set status = 'settled', settled_micros = ${actualMicros.toString()}::bigint, settled_at = now()
      where id = ${reservation.id}`
    const [budget] = await tx`select b.id, b.scope_type, b.period, b.limit_micros, b.currency, b.warn_thresholds,
        coalesce((select sum(a.delta_micros) from budget_adjustments a
          where a.budget_id = b.id and a.kind = 'temporary_raise' and a.created_at >= ${reservation.period_start}
            and (a.expires_at is null or a.expires_at > now())), 0) as raise_micros
      from budgets b where b.id = ${reservation.budget_id}`
    const limit = BigInt(budget.limit_micros) + BigInt(budget.raise_micros)
    if (limit === 0n) continue
    const spent = BigInt(counter.spent_micros)
    const percent = Number((spent * 100n) / limit)
    const thresholds = [...(budget.warn_thresholds as number[]), 100]
      .filter((threshold) => threshold > counter.last_alert_threshold && percent >= threshold)
      .toSorted((a, b) => a - b)
    for (const threshold of thresholds) {
      const [inserted] = await tx`insert into budget_alerts (budget_id, period_start, threshold, spent_micros, limit_micros)
        values (${budget.id}, ${reservation.period_start}, ${threshold}, ${spent.toString()}::bigint, ${limit.toString()}::bigint)
        on conflict do nothing returning id`
      if (inserted)
        crossed.push({
          budgetID: budget.id,
          scopeType: budget.scope_type,
          period: budget.period,
          threshold,
          spentMicros: spent,
          limitMicros: limit,
          currency: budget.currency,
        })
    }
    if (thresholds.length > 0)
      await tx`update budget_counters set last_alert_threshold = ${thresholds.at(-1)!}
        where budget_id = ${reservation.budget_id} and period_start = ${reservation.period_start}`
  }
  return crossed
}

export async function release(tx: Tx, requestUUID: string) {
  const reservations = await tx`select id, budget_id, period_start, reserved_micros from budget_reservations
    where request_id = ${requestUUID} and status = 'reserved' order by budget_id for update`
  for (const reservation of reservations) {
    await tx`update budget_counters set reserved_micros = greatest(0, reserved_micros - ${reservation.reserved_micros}::bigint)
      where budget_id = ${reservation.budget_id} and period_start = ${reservation.period_start}`
    await tx`update budget_reservations set status = 'released', settled_micros = 0, settled_at = now() where id = ${reservation.id}`
  }
}

function scopeLabel(budget: { scope_type: string }) {
  return (
    {
      org: "organization",
      project: "project",
      user: "personal",
      user_project: "personal project",
      model: "model",
    }[budget.scope_type] ?? budget.scope_type
  )
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
