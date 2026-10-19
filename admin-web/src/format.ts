export const money = (micros: number | string | null | undefined, currency = "USD") => {
  const value = Number(micros ?? 0) / 1_000_000
  const symbol = currency === "USD" ? "$" : currency === "CNY" ? "¥" : `${currency} `
  return `${symbol}${value.toLocaleString("en-US", { minimumFractionDigits: value !== 0 && Math.abs(value) < 1 ? 4 : 2, maximumFractionDigits: value !== 0 && Math.abs(value) < 1 ? 4 : 2 })}`
}

export const tokens = (value: number | string | null | undefined) => {
  const n = Number(value ?? 0)
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}K`
  return n.toLocaleString("en-US")
}

export const time = (value: string | Date | null | undefined) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"

export const date = (value: string | Date | null | undefined) => (value ? new Date(value).toLocaleDateString("zh-CN") : "—")

export const percent = (value: number | null | undefined) => (value === null || value === undefined ? "—" : `${value.toFixed(1)}%`)

export const statusLabel: Record<string, string> = {
  succeeded: "成功",
  failed: "失败",
  rejected: "已拒绝",
  cancelled: "已取消",
  pending: "等待中",
  streaming: "流式中",
}
export const billingLabel: Record<string, string> = { exact: "精确", estimated: "估算", unknown: "待对账", none: "不计费", pending: "待结算" }
export const severityLabel: Record<string, string> = { info: "信息提示", review: "待复核", high: "高危" }
export const riskStatusLabel: Record<string, string> = {
  open: "待处理",
  confirmed: "已确认",
  false_positive: "误报",
  resolved: "已处理",
  appealed: "申诉中",
}
export const categoryLabel: Record<string, string> = {
  secret_leak: "敏感凭据泄露",
  project_relevance: "疑似项目无关使用",
  resource_abuse: "资源滥用",
  cost_anomaly: "费用异常",
  attribution_switching: "频繁切换计费项目",
}
export const scopeLabel: Record<string, string> = { org: "企业", project: "项目组", user: "成员", user_project: "成员-项目", model: "模型" }
export const periodLabel: Record<string, string> = { daily: "每日", monthly: "每月", total: "累计" }

export function rangeDays(days: number) {
  return { from: new Date(Date.now() - days * 86400_000).toISOString(), to: new Date().toISOString() }
}
