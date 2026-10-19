import type { Sql } from "./db.js"
import type { Principal } from "./context.js"
import { redactValue } from "./redact.js"

export async function audit(
  sql: Sql,
  input: {
    actor?: Pick<Principal, "userID" | "accountType">
    actorType?: "admin" | "member" | "system" | "anonymous"
    action: string
    targetType?: string
    targetID?: string
    metadata?: Record<string, unknown>
    ip?: string
    requestID?: string
  },
) {
  const actorType = input.actorType ?? (input.actor ? (input.actor.accountType === "ADMIN" ? "admin" : "member") : "system")
  await sql`insert into audit_logs (actor_user_id, actor_type, action, target_type, target_id, metadata_redacted, ip, request_id)
    values (${input.actor?.userID ?? null}, ${actorType}, ${input.action}, ${input.targetType ?? null}, ${input.targetID ?? null},
      ${redactValue(input.metadata ?? {}) as object}, ${input.ip ?? null}, ${input.requestID ?? null})`
}

export async function notify(
  sql: Sql,
  input: { userID: string; category: string; title: string; body?: string; payload?: Record<string, unknown> },
) {
  const [row] = await sql`insert into notifications (user_id, category, title, body, payload)
    values (${input.userID}, ${input.category}, ${input.title}, ${input.body ?? ""}, ${input.payload ?? {}})
    returning id, created_at`
  return row as { id: string; created_at: Date }
}
