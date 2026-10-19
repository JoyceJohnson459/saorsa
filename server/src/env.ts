import { z } from "zod"

const Env = z.object({
  TEAMOS_DATABASE_URL: z.string().min(1),
  TEAMOS_REDIS_URL: z.string().min(1),
  TEAMOS_PORT: z.coerce.number().int().positive().default(8787),
  TEAMOS_HOST: z.string().default("127.0.0.1"),
  // Public origin members' browsers and OpenCode clients use, e.g. https://saorsa.tech (planned domain; configure your own)
  TEAMOS_PUBLIC_URL: z.string().url().default("http://127.0.0.1:8787"),
  // Comma separated "version:base64(32 bytes)" pairs; SAORSA_MASTER_KEY_ACTIVE picks the one used for new secrets.
  TEAMOS_MASTER_KEYS: z.string().min(1),
  TEAMOS_MASTER_KEY_ACTIVE: z.coerce.number().int().positive().default(1),
  // One-time secret required by POST /api/auth/bootstrap. Ignored once an admin exists.
  TEAMOS_BOOTSTRAP_TOKEN: z.string().min(24).optional(),
  // Development/test only: lets admins register upstreams on loopback/private addresses (e.g. the mock upstream).
  TEAMOS_ALLOW_PRIVATE_UPSTREAMS: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Extra upstream hosts allowed in addition to the built-in list (comma separated, exact host match).
  TEAMOS_UPSTREAM_HOST_ALLOWLIST: z.string().default(""),
  TEAMOS_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  TEAMOS_CLIENT_SESSION_TTL_DAYS: z.coerce.number().int().positive().default(30),
  // Lifetime of the per-launch token the Launcher hands to a tool process (not extended by use).
  TEAMOS_TOOL_TOKEN_TTL_HOURS: z.coerce.number().int().positive().max(168).default(12),
  TEAMOS_WEB_SESSION_TTL_HOURS: z.coerce.number().int().positive().default(12),
  TEAMOS_ADMIN_WEB_DIST: z.string().optional(),
  // Directory with Saorsa Launcher builds (saorsa-<platform>, .sha256 files, VERSION) served under /downloads.
  TEAMOS_DOWNLOADS_DIR: z.string().optional(),
  TEAMOS_COOKIE_SECURE: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
  TEAMOS_TRUST_PROXY: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  // Upstream must send response headers within this time, and then never go silent longer than the idle timeout.
  TEAMOS_UPSTREAM_HEADER_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  TEAMOS_UPSTREAM_IDLE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  TEAMOS_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
})

export type Env = z.infer<typeof Env>

/**
 * Deployments configure `SAORSA_*`. Earlier names stay accepted so existing installs keep working: the schema
 * keeps the original `TEAMOS_*` names, and `SAORSA_*` beats `NEXCODE_*` beats `TEAMOS_*` when several are set.
 * An empty variable counts as unset: Compose passes `${NAME:-}` as "" when the operator leaves NAME out.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const set = Object.entries(source).filter(([, value]) => value !== undefined && value !== "")
  const alias = (prefix: string) =>
    Object.fromEntries(set.filter(([name]) => name.startsWith(prefix)).map(([name, value]) => [`TEAMOS_${name.slice(prefix.length)}`, value]))
  const parsed = Env.safeParse({ ...Object.fromEntries(set), ...alias("NEXCODE_"), ...alias("SAORSA_") })
  if (parsed.success) return parsed.data
  const fields = parsed.error.issues.map((issue) => `${issue.path.join(".").replace(/^TEAMOS_/, "SAORSA_")}: ${issue.message}`).join("; ")
  throw new Error(`Invalid Saorsa environment: ${fields}`)
}

/** Upstream hosts that are always permitted; anything else needs SAORSA_UPSTREAM_HOST_ALLOWLIST. */
export const BUILTIN_UPSTREAM_HOSTS = [
  "api.openai.com",
  "api.anthropic.com",
  "api.deepseek.com",
  "open.bigmodel.cn",
  "ark.cn-beijing.volces.com",
  "dashscope.aliyuncs.com",
  "api.moonshot.cn",
  "openrouter.ai",
]
