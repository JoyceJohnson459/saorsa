import type { Deps } from "./context.js"
import type { Sql } from "./db.js"
import { notify } from "./audit.js"
import { findSecrets, redactSecrets, type SecretFinding } from "./redact.js"

export type Severity = "info" | "review" | "high"

export interface Rule {
  rule_type: string
  enabled: boolean
  action: "flag" | "block"
  config: Record<string, unknown>
}

export async function loadRules(sql: Sql) {
  const rows = (await sql`select rule_type, enabled, action, config from policy_rules`) as Rule[]
  return new Map(rows.map((row) => [row.rule_type, row]))
}

/** OpenAI-style chat message, narrowed to the parts risk detection reads. */
export interface ChatMessage {
  role: string
  content?: unknown
}

export function messageText(message: ChatMessage) {
  return contentText(message.content)
}

// Handles OpenAI parts ({type:"text",text}) and Anthropic blocks, including tool_result blocks whose
// `content` nests further text blocks (file contents the agent read are a common leak path).
function contentText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      if ("text" in part && typeof part.text === "string") return part.text
      if ("content" in part) return contentText(part.content)
      return ""
    })
    .join("\n")
}

/** A message a person typed, as opposed to an Anthropic user-role message carrying tool results. */
export function isHumanPrompt(message: ChatMessage | undefined) {
  if (!message || message.role !== "user") return false
  if (!Array.isArray(message.content)) return true
  return !message.content.some((part) => part && typeof part === "object" && "type" in part && part.type === "tool_result")
}

/**
 * Only content added since the last assistant turn is new; earlier history was already scanned when it
 * was first sent. This keeps one leaked secret from producing an event on every subsequent step.
 */
export function trailingMessages(messages: ChatMessage[]) {
  const lastAssistant = messages.findLastIndex((message) => message.role === "assistant")
  return messages.slice(lastAssistant + 1)
}

export function scanSecrets(messages: ChatMessage[]) {
  return findSecrets(trailingMessages(messages).map(messageText).join("\n"))
}

export async function recordRisk(
  deps: Pick<Deps, "sql" | "realtime">,
  input: {
    userID: string
    projectID?: string
    requestUUID?: string
    category: string
    severity: Severity
    confidence: number
    detector: string
    summary: string
    evidence: Record<string, unknown>
    dedupeKey: string
  },
) {
  const [row] = await deps.sql`insert into risk_events (user_id, project_id, request_id, category, severity, confidence, detector,
      summary_redacted, evidence, dedupe_key)
    values (${input.userID}, ${input.projectID ?? null}, ${input.requestUUID ?? null}, ${input.category}, ${input.severity},
      ${input.confidence}, ${input.detector}, ${redactSecrets(input.summary)}, ${input.evidence}, ${input.dedupeKey})
    on conflict (dedupe_key) do nothing
    returning id`
  if (!row) return undefined
  await notify(deps.sql, {
    userID: input.userID,
    category: "risk",
    title: input.severity === "high" ? "A request was flagged by a security policy" : "A usage pattern was flagged for review",
    body: `${redactSecrets(input.summary)} This is a review prompt, not a finding of misconduct. You can view it and appeal under My usage → Risk notices.`,
    payload: { riskEventID: row.id },
  })
  await deps.realtime.publish({
    type: "risk.created",
    userID: input.userID,
    projectID: input.projectID,
    data: { id: row.id, category: input.category, severity: input.severity, summary: redactSecrets(input.summary) },
  })
  return row.id as string
}

export function secretRiskEvents(findings: SecretFinding[], ctx: { userID: string; projectID: string; blocked: boolean }) {
  return findings.map((finding) => ({
    userID: ctx.userID,
    projectID: ctx.projectID,
    category: "secret_leak",
    severity: "high" as const,
    confidence: 0.95,
    detector: `rule:secret_leak:${finding.id}`,
    summary: `${finding.label} detected in content sent to a managed model${ctx.blocked ? " (request blocked by policy)" : ""}.`,
    evidence: {
      rule: "secret_leak",
      pattern: finding.id,
      fingerprint: finding.fingerprint,
      excerpt_redacted: finding.excerpt,
      explanation: `Matched the deterministic ${finding.label} pattern. The secret value itself is not stored; only a hash fingerprint and a redacted excerpt are kept.`,
      blocked: ctx.blocked,
    },
    dedupeKey: `secret:${ctx.userID}:${finding.fingerprint}`,
  }))
}

const STOPWORDS = new Set(
  "the a an and or of to in for on with is are be this that it as at by from we you i our your please can could would should will just use using make add fix code file function project 的 了 和 是 在 我 你 请 一个 这个 帮 帮我 代码 文件 函数 项目".split(
    " ",
  ),
)

function keywords(text: string) {
  return new Set(
    (text.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter((word) => !STOPWORDS.has(word) && word.length <= 40),
  )
}

/**
 * Keyword relevance: an explainable, deliberately weak signal. It can only ever produce an "info"
 * hint for human review, never a violation, and it never inspects the member's repository.
 */
export function keywordRelevance(prompt: string, project: { name: string; purpose: string; description: string; tags: string[] }) {
  const projectWords = keywords([project.name, project.purpose, project.description, ...project.tags].join(" "))
  const promptWords = keywords(prompt)
  if (projectWords.size === 0 || promptWords.size < 8) return undefined
  const overlap = [...promptWords].filter((word) => projectWords.has(word))
  return {
    overlapRatio: overlap.length / promptWords.size,
    matched: overlap.slice(0, 20),
    projectKeywords: [...projectWords].slice(0, 30),
    promptKeywordCount: promptWords.size,
  }
}

export interface RelevanceVerdict {
  related: boolean
  confidence: number
  reasons: string[]
}

/** Optional second-model classifier. Only runs when an admin explicitly allowed content to leave for auditing. */
export async function auditModelRelevance(
  deps: Pick<Deps, "fetch">,
  config: { endpoint: string; model: string; apiKey?: string },
  prompt: string,
  project: { name: string; purpose: string },
): Promise<RelevanceVerdict | undefined> {
  const response = await deps.fetch(`${config.endpoint.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            'You check whether a developer request plausibly relates to the stated project purpose. Respond only with JSON {"related":boolean,"confidence":number,"reasons":string[]}. When unsure, answer related=true.',
        },
        { role: "user", content: `Project: ${project.name}\nPurpose: ${project.purpose}\n\nRequest:\n${redactSecrets(prompt).slice(0, 4000)}` },
      ],
    }),
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  })
  if (!response.ok) return undefined
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = body.choices?.[0]?.message?.content ?? ""
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return undefined
  try {
    const parsed = JSON.parse(match[0]) as Partial<RelevanceVerdict>
    if (typeof parsed.related !== "boolean") return undefined
    return {
      related: parsed.related,
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String).slice(0, 5) : [],
    }
  } catch {
    return undefined
  }
}
