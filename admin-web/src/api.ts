import { ElMessage } from "element-plus"
import { reactive } from "vue"

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown, options: { quiet?: boolean } = {}): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), "x-teamos-csrf": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  const json = text ? (JSON.parse(text) as Record<string, any>) : {}
  if (!response.ok) {
    const error = new ApiError(response.status, json.error?.code ?? "error", json.error?.message ?? response.statusText)
    // Quiet probes (the session check) leave routing to the guard, which also handles first-run setup.
    if (response.status === 401 && !options.quiet && !path.startsWith("/api/auth/") && !location.pathname.startsWith("/login")) {
      session.user = undefined
      const reason = error.code === "session_replaced" ? "reason=replaced&" : ""
      location.href = `/login?${reason}next=${encodeURIComponent(location.pathname + location.search)}`
    } else if (!options.quiet) ElMessage.error(error.message)
    throw error
  }
  return json as T
}

export const api = {
  get: <T = any>(path: string, options?: { quiet?: boolean }) => request<T>("GET", path, undefined, options),
  post: <T = any>(path: string, body: unknown = {}, options?: { quiet?: boolean }) => request<T>("POST", path, body, options),
  patch: <T = any>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T = any>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T = any>(path: string) => request<T>("DELETE", path),
}

export interface Me {
  id: string
  username: string
  displayName: string
  email: string | null
  accountType: "ADMIN" | "MEMBER"
  mustChangePassword: boolean
}

export const session = reactive<{ user?: Me; organization?: string; noticeAcknowledged?: boolean; loaded: boolean }>({ loaded: false })

export async function loadSession() {
  try {
    const me = await api.get<{ user: Me; organization: string; notice: { acknowledged: boolean } }>("/api/me", { quiet: true })
    session.user = me.user
    session.organization = me.organization
    session.noticeAcknowledged = me.notice.acknowledged
  } catch {
    session.user = undefined
  }
  session.loaded = true
  return session.user
}

export function query(params: Record<string, string | string[] | number | undefined | null>) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue
    for (const item of Array.isArray(value) ? value : [value]) search.append(key, String(item))
  }
  const text = search.toString()
  return text ? `?${text}` : ""
}

/** Subscribes to an authenticated SSE stream; reconnects automatically (EventSource default). */
export function subscribe(path: string, onEvent: (type: string, data: any) => void) {
  const source = new EventSource(path, { withCredentials: true })
  const types = ["usage.request", "budget.alert", "risk.created", "risk.reviewed", "risk.appealed", "key.lease"]
  for (const type of types) source.addEventListener(type, (event) => onEvent(type, JSON.parse((event as MessageEvent).data)))
  source.addEventListener("ready", () => onEvent("ready", {}))
  // Signed in on another device: leave immediately instead of waiting for the next API call.
  source.addEventListener("session.ended", () => {
    source.close()
    session.user = undefined
    location.href = "/login?reason=replaced"
  })
  return () => source.close()
}
