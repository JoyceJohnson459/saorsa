import type { Sql } from "./db.js"

export interface OrgSettings {
  name: string
  timezone: string
  userRequestsPerMinute: number
  projectRequestsPerMinute: number
  userConcurrency: number
  /** Sliding one-minute token windows (input at admission, corrected with real input+output). null = unlimited. */
  userTokensPerMinute: number | null
  projectTokensPerMinute: number | null
  /** Employee-facing audit notice; members must acknowledge the current version before connecting OpenCode. */
  noticeVersion: number
  noticeText: string
  /** Full prompt retention is off by default; only redacted evidence is stored. */
  retainFullContent: boolean
  riskRetentionDays: number
  requestRetentionDays: number
  /** Optional floor for official OpenCode releases (e.g. "1.19.0"); older clients are asked to upgrade. */
  minOpenCodeVersion: string | null
  /** When true the remote config denies every non-Saorsa provider in OpenCode clients connected to Saorsa. */
  restrictToManagedProviders: boolean
  /** A new login on a channel (web console or OpenCode) signs that channel out on every other device. */
  singleDeviceLogin: boolean
  /**
   * "exclusive": every member holds at most one provider key and every key serves one member, so n keys mean
   * n members working at once (first come, first served). "shared": all keys serve everyone.
   */
  keyAssignment: "exclusive" | "shared"
  /** An exclusive key is released after this many minutes without gateway traffic from its holder. */
  keyLeaseIdleMinutes: number
}

export const DEFAULT_NOTICE = `Saorsa 使用告知 / Usage notice

1. 覆盖范围：仅限通过 Saorsa 企业网关发起的 AI 模型请求（“受管调用”）。未经网关的本地或个人账户活动不在采集范围内，也不会被采集。
2. 采集内容：请求时间、成员、计费项目组、模型、Token 用量、费用、状态码。默认不保存对话全文；安全规则命中时仅保存脱敏片段与哈希指纹。
3. 目的：成本归集、预算控制、密钥泄露防护与资源滥用识别。风险提示需人工复核，不作为绩效评价依据，也不会仅因 AI 分类结果认定违规。
4. 查看权限：管理员可查看统计与脱敏风险证据；成员只能查看本人数据。所有管理员访问风险详情的操作均记入审计日志。
5. 保留期：请求明细默认保留 180 天，风险记录默认保留 365 天。
6. 申诉：成员可在“我的使用量 → 风险提示”中对任何风险记录发起申诉，管理员复核后会通知结果。`

const DEFAULTS: OrgSettings = {
  name: "Saorsa",
  timezone: "Asia/Shanghai",
  userRequestsPerMinute: 120,
  projectRequestsPerMinute: 1200,
  userConcurrency: 6,
  userTokensPerMinute: 2_000_000,
  projectTokensPerMinute: 20_000_000,
  noticeVersion: 1,
  noticeText: DEFAULT_NOTICE,
  retainFullContent: false,
  riskRetentionDays: 365,
  requestRetentionDays: 180,
  restrictToManagedProviders: true,
  minOpenCodeVersion: null,
  singleDeviceLogin: true,
  keyAssignment: "exclusive",
  keyLeaseIdleMinutes: 30,
}

let cache: { value: OrgSettings; at: number } | undefined

export async function orgSettings(sql: Sql): Promise<OrgSettings> {
  if (cache && Date.now() - cache.at < 5_000) return cache.value
  const [row] = await sql`select name, settings from organization where id = 1`
  const value = { ...DEFAULTS, ...(row?.settings ?? {}), name: row?.name ?? DEFAULTS.name }
  cache = { value, at: Date.now() }
  return value
}

export function invalidateSettings() {
  cache = undefined
}
