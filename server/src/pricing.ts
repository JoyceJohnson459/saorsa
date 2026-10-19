import type { Sql } from "./db.js"

export interface PriceVersion {
  id: string
  currency: string
  input: bigint
  output: bigint
  cacheRead: bigint
  cacheWrite: bigint
  /** Undefined means reasoning tokens are billed at the output price (the common provider convention). */
  reasoning: bigint | undefined
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

export type Category = "input" | "output" | "cache_read" | "cache_write" | "reasoning"

/** The price row effective at `at`; history never drifts when an admin edits prices later. */
export async function priceAt(sql: Sql, modelID: string, at: Date): Promise<PriceVersion | undefined> {
  const [row] = await sql`select id, currency, input_per_mtok_micros, output_per_mtok_micros, cache_read_per_mtok_micros,
      cache_write_per_mtok_micros, reasoning_per_mtok_micros
    from pricing_versions where model_id = ${modelID} and effective_from <= ${at}
    order by effective_from desc, created_at desc limit 1`
  if (!row) return undefined
  return {
    id: row.id,
    currency: row.currency,
    input: BigInt(row.input_per_mtok_micros),
    output: BigInt(row.output_per_mtok_micros),
    cacheRead: BigInt(row.cache_read_per_mtok_micros),
    cacheWrite: BigInt(row.cache_write_per_mtok_micros),
    reasoning: row.reasoning_per_mtok_micros === null ? undefined : BigInt(row.reasoning_per_mtok_micros),
  }
}

/** Cost in micro-units, rounded half-up per line: tokens * price_per_million / 1e6. */
export function lineCost(tokens: number, pricePerMTok: bigint) {
  return (BigInt(tokens) * pricePerMTok + 500_000n) / 1_000_000n
}

/**
 * Splits provider usage into billable lines. OpenAI-style `prompt_tokens` include cached tokens and
 * `completion_tokens` include reasoning tokens, so those subsets are carved out to avoid double billing.
 */
export function billableLines(usage: Usage, price: PriceVersion) {
  const input = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite)
  const reasoningPrice = price.reasoning ?? price.output
  const output = Math.max(0, usage.output - usage.reasoning)
  const lines: Array<{ category: Category; tokens: number; unitPrice: bigint; cost: bigint }> = [
    { category: "input", tokens: input, unitPrice: price.input, cost: lineCost(input, price.input) },
    { category: "output", tokens: output, unitPrice: price.output, cost: lineCost(output, price.output) },
    { category: "cache_read", tokens: usage.cacheRead, unitPrice: price.cacheRead, cost: lineCost(usage.cacheRead, price.cacheRead) },
    {
      category: "cache_write",
      tokens: usage.cacheWrite,
      unitPrice: price.cacheWrite,
      cost: lineCost(usage.cacheWrite, price.cacheWrite),
    },
    { category: "reasoning", tokens: usage.reasoning, unitPrice: reasoningPrice, cost: lineCost(usage.reasoning, reasoningPrice) },
  ]
  return lines.filter((line) => line.tokens > 0)
}

/** Conservative pre-request ceiling used for budget reservations (input estimated from request size). */
export function estimateCeiling(input: { requestBytes: number; maxOutputTokens: number }, price: PriceVersion) {
  // ~3 bytes per token is pessimistic for code and English, so the reservation errs high.
  const inputTokens = Math.ceil(input.requestBytes / 3)
  const outputPrice = price.reasoning !== undefined && price.reasoning > price.output ? price.reasoning : price.output
  return lineCost(inputTokens, price.input) + lineCost(input.maxOutputTokens, outputPrice)
}

export function formatMoney(micros: bigint | number, currency = "USD") {
  const value = Number(micros) / 1_000_000
  // Sub-cent amounts keep enough precision to be distinguishable from zero.
  const digits = value === 0 || value >= 1 ? 2 : value >= 0.0001 ? 4 : 6
  return `${currency === "USD" ? "$" : `${currency} `}${value.toFixed(digits)}`
}
