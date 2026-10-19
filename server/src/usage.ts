import { z } from "zod"
import type { Sql } from "./db.js"
import { num } from "./db.js"

export const UsageFilter = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  projectIDs: z.array(z.string().uuid()).optional(),
  userIDs: z.array(z.string().uuid()).optional(),
  modelIDs: z.array(z.string().uuid()).optional(),
  providerIDs: z.array(z.string().uuid()).optional(),
  toolIDs: z.array(z.string().regex(/^[a-z-]{2,40}$/)).optional(),
  status: z.enum(["pending", "streaming", "succeeded", "failed", "rejected", "cancelled"]).optional(),
  billing: z.enum(["exact", "estimated", "unknown", "none", "pending"]).optional(),
  risk: z.enum(["any", "info", "review", "high"]).optional(),
})
export type UsageFilter = z.infer<typeof UsageFilter>

/** Parses repeated or comma separated query params into the filter shape. */
export function filterFromQuery(query: Record<string, string | string[] | undefined>): UsageFilter {
  const list = (value: string | string[] | undefined) =>
    value === undefined ? undefined : (Array.isArray(value) ? value : [value]).flatMap((item) => item.split(",")).filter(Boolean)
  const single = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) || undefined
  return UsageFilter.parse({
    from: single(query.from),
    to: single(query.to),
    projectIDs: list(query.project),
    userIDs: list(query.user),
    modelIDs: list(query.model),
    providerIDs: list(query.provider),
    toolIDs: list(query.tool),
    status: single(query.status),
    billing: single(query.billing),
    risk: single(query.risk),
  })
}

interface Bound {
  from: Date
  to: Date
  projects: string[] | null
  users: string[] | null
  models: string[] | null
  providers: string[] | null
  tools: string[] | null
  status: string | null
  billing: string | null
  risk: string | null
}

function bind(filter: UsageFilter): Bound {
  const to = filter.to ?? new Date()
  return {
    from: filter.from ?? new Date(to.getTime() - 30 * 86400_000),
    to,
    projects: filter.projectIDs?.length ? filter.projectIDs : null,
    users: filter.userIDs?.length ? filter.userIDs : null,
    models: filter.modelIDs?.length ? filter.modelIDs : null,
    providers: filter.providerIDs?.length ? filter.providerIDs : null,
    tools: filter.toolIDs?.length ? filter.toolIDs : null,
    status: filter.status ?? null,
    billing: filter.billing ?? null,
    risk: filter.risk ?? null,
  }
}

// One static predicate with nullable parameters: every filter is a bound value, never interpolated SQL.
function where(sql: Sql, b: Bound) {
  const arr = (value: string[] | null) => (value ? sql.array(value, "uuid") : null)
  return sql`r.started_at >= ${b.from} and r.started_at < ${b.to}
    and (${arr(b.projects)}::uuid[] is null or r.project_id = any(${arr(b.projects)}::uuid[]))
    and (${arr(b.users)}::uuid[] is null or r.user_id = any(${arr(b.users)}::uuid[]))
    and (${arr(b.models)}::uuid[] is null or r.model_id = any(${arr(b.models)}::uuid[]))
    and (${arr(b.providers)}::uuid[] is null or r.provider_id = any(${arr(b.providers)}::uuid[]))
    and (${b.tools ? sql.array(b.tools, "text") : null}::text[] is null or r.tool_id = any(${b.tools ? sql.array(b.tools, "text") : null}::text[]))
    and (${b.status}::text is null or r.status = ${b.status})
    and (${b.billing}::text is null or r.billing_status = ${b.billing})
    and (${b.risk}::text is null or (${b.risk} = 'any' and r.risk_level is not null) or r.risk_level = ${b.risk})`
}

const totals = (row: Record<string, unknown>) => ({
  requests: num(row.requests),
  succeeded: num(row.succeeded),
  failed: num(row.failed),
  rejected: num(row.rejected),
  inputTokens: num(row.input_tokens),
  outputTokens: num(row.output_tokens),
  cacheReadTokens: num(row.cache_read_tokens),
  cacheWriteTokens: num(row.cache_write_tokens),
  reasoningTokens: num(row.reasoning_tokens),
  costMicros: num(row.cost_micros),
  estimatedCostMicros: num(row.estimated_cost_micros),
  estimatedRequests: num(row.estimated_requests),
})

const AGG = `count(*) as requests,
  count(*) filter (where r.status = 'succeeded') as succeeded,
  count(*) filter (where r.status in ('failed', 'cancelled')) as failed,
  count(*) filter (where r.status = 'rejected') as rejected,
  coalesce(sum(r.input_tokens), 0) as input_tokens,
  coalesce(sum(r.output_tokens), 0) as output_tokens,
  coalesce(sum(r.cache_read_tokens), 0) as cache_read_tokens,
  coalesce(sum(r.cache_write_tokens), 0) as cache_write_tokens,
  coalesce(sum(r.reasoning_tokens), 0) as reasoning_tokens,
  coalesce(sum(r.cost_micros), 0) as cost_micros,
  coalesce(sum(r.cost_micros) filter (where r.billing_status <> 'exact'), 0) as estimated_cost_micros,
  count(*) filter (where r.billing_status in ('estimated', 'unknown')) as estimated_requests`

export async function summary(sql: Sql, filter: UsageFilter) {
  const b = bind(filter)
  const [row] = await sql`select ${sql.unsafe(AGG)}, count(distinct r.user_id) as active_members,
      count(distinct r.project_id) as active_projects
    from gateway_requests r where ${where(sql, b)}`
  return { ...totals(row), activeMembers: num(row.active_members), activeProjects: num(row.active_projects), from: b.from, to: b.to }
}

export async function timeseries(sql: Sql, filter: UsageFilter, bucket: "hour" | "day", timezone: string) {
  const b = bind(filter)
  const rows = await sql`select date_trunc(${bucket}, r.started_at, ${timezone}) as bucket, ${sql.unsafe(AGG)}
    from gateway_requests r where ${where(sql, b)}
    group by 1 order by 1`
  return rows.map((row: Record<string, unknown>) => ({ bucket: row.bucket, ...totals(row) }))
}

export async function breakdown(sql: Sql, filter: UsageFilter, by: "project" | "user" | "model" | "provider" | "tool") {
  const b = bind(filter)
  const rows =
    by === "project"
      ? await sql`select r.project_id as key, p.code || ' · ' || p.name as label, ${sql.unsafe(AGG)}
          from gateway_requests r join projects p on p.id = r.project_id where ${where(sql, b)}
          group by 1, 2 order by cost_micros desc, requests desc`
      : by === "user"
        ? await sql`select r.user_id as key, u.display_name || ' (' || u.username || ')' as label, ${sql.unsafe(AGG)}
            from gateway_requests r join users u on u.id = r.user_id where ${where(sql, b)}
            group by 1, 2 order by cost_micros desc, requests desc`
        : by === "model"
          ? await sql`select r.model_id as key, r.model_alias as label, ${sql.unsafe(AGG)}
              from gateway_requests r where ${where(sql, b)}
              group by 1, 2 order by cost_micros desc, requests desc`
          : by === "provider"
            ? await sql`select r.provider_id as key, pr.name as label, ${sql.unsafe(AGG)}
                from gateway_requests r left join providers pr on pr.id = r.provider_id where ${where(sql, b)}
                group by 1, 2 order by cost_micros desc, requests desc`
            : await sql`select r.tool_id as key, r.tool_id as label, ${sql.unsafe(AGG)}
                from gateway_requests r where ${where(sql, b)}
                group by 1, 2 order by cost_micros desc, requests desc`
  return rows.map((row: Record<string, unknown>) => ({ key: row.key as string, label: row.label as string, ...totals(row) }))
}

/**
 * Usage per tool for one filter (the member workbench): totals, last request and version, the models used,
 * and a daily series in the organization's timezone. Requests without a tool (none since migration 0004) are
 * left out.
 */
export async function toolUsage(sql: Sql, filter: UsageFilter, timezone: string) {
  const b = bind(filter)
  const [rows, models, days] = await Promise.all([
    sql`select r.tool_id, ${sql.unsafe(AGG)}, max(r.started_at) as last_request_at,
        (array_agg(r.tool_version order by r.started_at desc) filter (where r.tool_version is not null))[1] as last_version,
        avg(r.duration_ms) filter (where r.status = 'succeeded') as avg_duration_ms
      from gateway_requests r where ${where(sql, b)} and r.tool_id is not null group by 1`,
    sql`select r.tool_id, r.model_alias, count(*) as requests, coalesce(sum(r.cost_micros), 0) as cost_micros
      from gateway_requests r where ${where(sql, b)} and r.tool_id is not null group by 1, 2 order by requests desc`,
    sql`select r.tool_id, date_trunc('day', r.started_at, ${timezone}) as day, count(*) as requests, coalesce(sum(r.cost_micros), 0) as cost_micros
      from gateway_requests r where ${where(sql, b)} and r.tool_id is not null group by 1, 2 order by 2`,
  ])
  return new Map(
    rows.map((row: Record<string, unknown>) => [
      row.tool_id as string,
      {
        ...totals(row),
        lastRequestAt: row.last_request_at as Date,
        lastVersion: (row.last_version as string | null) ?? null,
        avgDurationMs: row.avg_duration_ms === null ? null : Math.round(Number(row.avg_duration_ms)),
        models: models
          .filter((model: Record<string, unknown>) => model.tool_id === row.tool_id)
          .slice(0, 5)
          .map((model: Record<string, unknown>) => ({ alias: model.model_alias as string, requests: num(model.requests), costMicros: num(model.cost_micros) })),
        series: days
          .filter((day: Record<string, unknown>) => day.tool_id === row.tool_id)
          .map((day: Record<string, unknown>) => ({ day: day.day as Date, requests: num(day.requests), costMicros: num(day.cost_micros) })),
      },
    ]),
  )
}

export async function requests(sql: Sql, filter: UsageFilter, page: { offset: number; limit: number; sort: "time" | "cost" }) {
  const b = bind(filter)
  const rows = await sql`select r.id, r.request_id, r.trace_id, r.started_at, r.ended_at, r.duration_ms, r.status, r.http_status,
      r.error_code, r.error_message, r.model_alias, r.stream, r.billing_status, r.input_tokens, r.output_tokens, r.cache_read_tokens,
      r.cache_write_tokens, r.reasoning_tokens, r.cost_micros, r.currency, r.risk_level, r.attempts, r.opencode_session_id,
      r.upstream_request_id, r.tool_id, r.tool_version, r.project_id, p.code as project_code, p.name as project_name, r.user_id, u.username, u.display_name,
      pr.name as provider_name, count(*) over () as total
    from gateway_requests r
    join projects p on p.id = r.project_id
    join users u on u.id = r.user_id
    left join providers pr on pr.id = r.provider_id
    where ${where(sql, b)}
    order by case when ${page.sort} = 'cost' then r.cost_micros end desc nulls last, r.started_at desc
    offset ${page.offset} limit ${page.limit}`
  return {
    total: num(rows[0]?.total),
    items: rows.map((row: Record<string, unknown>) => ({
      ...row,
      total: undefined,
      input_tokens: num(row.input_tokens),
      output_tokens: num(row.output_tokens),
      cache_read_tokens: num(row.cache_read_tokens),
      cache_write_tokens: num(row.cache_write_tokens),
      reasoning_tokens: num(row.reasoning_tokens),
      cost_micros: num(row.cost_micros),
    })),
  }
}

/** CSV export with formula-injection protection for spreadsheet consumers. */
export function toCSV(rows: Array<Record<string, unknown>>, columns: string[]) {
  const cell = (value: unknown) => {
    const text = value instanceof Date ? value.toISOString() : value === null || value === undefined ? "" : String(value)
    const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text
    return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe
  }
  return [columns.join(","), ...rows.map((row) => columns.map((column) => cell(row[column])).join(","))].join("\n")
}
