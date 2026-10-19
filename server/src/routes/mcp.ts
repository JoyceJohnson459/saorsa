import type { Hono } from "hono"
import type { AppEnv, Deps, Principal } from "../context.js"
import { bearer, principalFromToken } from "../auth.js"
import { formatMoney } from "../pricing.js"
import { summary } from "../usage.js"
import { authorizedModels } from "../gateway.js"
import { budgetStatus } from "./budget-status.js"
import { keyPools } from "../keys.js"
import { orgSettings } from "../settings.js"

const TOOLS = [
  {
    name: "saorsa_status",
    description:
      "Show the member's current Saorsa billing project, the managed models it authorizes, and the member's own budget status. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "saorsa_usage",
    description: "Summarize the member's own managed model usage (requests, tokens, cost) for the last N days. Read-only.",
    inputSchema: {
      type: "object",
      properties: { days: { type: "integer", minimum: 1, maximum: 90, description: "Look-back window in days (default 7)" } },
      additionalProperties: false,
    },
  },
]

/**
 * Minimal MCP (streamable HTTP, JSON responses) server that Saorsa pushes to connected OpenCode clients
 * through remote config. It only exposes the caller's own data, authenticated by their client session.
 */
export function mcpRoutes(app: Hono<AppEnv>) {
  app.get("/mcp", (c) => c.body(null, 405, { allow: "POST" }))
  app.post("/mcp", async (c) => {
    const deps = c.get("deps")
    const credential = bearer(c)
    const principal = credential?.via === "header" ? await principalFromToken(deps, credential.token) : undefined
    if (!principal || principal.sessionKind !== "client") return c.json({ error: "unauthorized" }, 401)
    const payload = await c.req.json().catch(() => undefined)
    const messages = Array.isArray(payload) ? payload : [payload]
    const responses = (await Promise.all(messages.map((message) => handle(deps, principal, message)))).filter(Boolean)
    if (responses.length === 0) return c.body(null, 202)
    return c.json(Array.isArray(payload) ? responses : responses[0])
  })
}

async function handle(deps: Deps, principal: Principal, message: unknown) {
  if (!message || typeof message !== "object") return rpcError(null, -32600, "Invalid request")
  const request = message as { id?: string | number; method?: string; params?: Record<string, unknown> }
  if (request.id === undefined) return undefined
  if (request.method === "initialize")
    return result(request.id, {
      protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "saorsa", version: "1.0.0" },
      instructions: "Saorsa usage tools. Data shown covers managed gateway traffic only.",
    })
  if (request.method === "ping") return result(request.id, {})
  if (request.method === "tools/list") return result(request.id, { tools: TOOLS })
  if (request.method === "tools/call") {
    const name = request.params?.name
    const args = (request.params?.arguments ?? {}) as Record<string, unknown>
    if (name === "saorsa_status") return result(request.id, text(await status(deps, principal)))
    if (name === "saorsa_usage") return result(request.id, text(await usage(deps, principal, Number(args.days) || 7)))
    return rpcError(request.id, -32602, `Unknown tool ${String(name)}`)
  }
  return rpcError(request.id, -32601, `Method not found: ${String(request.method)}`)
}

async function status(deps: Deps, principal: Principal) {
  const [project] = await deps.sql`select code, name from projects where id = ${principal.projectID ?? null}`
  const models = principal.projectID ? await authorizedModels(deps, principal.projectID, principal.toolID) : []
  const budgets = await budgetStatus(deps, { userID: principal.userID })
  const exclusive = (await orgSettings(deps.sql)).keyAssignment === "exclusive"
  const pools = exclusive ? (await keyPools(deps, principal.userID)).filter((pool) => models.some((model) => model.provider_id === pool.id)) : []
  return [
    `Billing project: ${project ? `${project.code} · ${project.name}` : "none"}`,
    `Authorized models: ${models.map((model) => model.alias).join(", ") || "none"}`,
    budgets.length
      ? `Budgets:\n${budgets
          .map(
            (budget: Record<string, unknown>) =>
              `- ${budget.scope_type}${budget.project_code ? ` ${budget.project_code}` : ""} ${budget.period}: ${formatMoney(Number(budget.spent_micros), String(budget.currency))} of ${formatMoney(Number(budget.effective_limit_micros), String(budget.currency))} (${budget.percent ?? 0}%)`,
          )
          .join("\n")}`
      : "Budgets: no personal budget configured",
    ...(exclusive
      ? [
          `Free keys (each key serves one member at a time): ${pools.map((pool) => `${pool.name}(${pool.free}/${pool.total}${pool.mine ? ", yours" : ""})`).join(", ") || "none"}`,
        ]
      : []),
    "To switch the billing project, use the Saorsa web console (My workbench) or log in again.",
  ].join("\n")
}

async function usage(deps: Deps, principal: Principal, days: number) {
  const window = Math.min(90, Math.max(1, Math.floor(days)))
  const totals = await summary(deps.sql, { userIDs: [principal.userID], from: new Date(Date.now() - window * 86400_000) })
  return [
    `Your managed usage, last ${window} day(s):`,
    `Requests: ${totals.requests} (succeeded ${totals.succeeded}, failed ${totals.failed}, rejected ${totals.rejected})`,
    `Tokens: input ${totals.inputTokens}, output ${totals.outputTokens}, cache read ${totals.cacheReadTokens}`,
    `Cost: ${formatMoney(totals.costMicros)}${totals.estimatedRequests ? ` (includes ${totals.estimatedRequests} estimated request(s))` : ""}`,
  ].join("\n")
}

const text = (value: string) => ({ content: [{ type: "text", text: value }] })
const result = (id: string | number, value: unknown) => ({ jsonrpc: "2.0", id, result: value })
const rpcError = (id: string | number | null, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } })
