import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { ApiError } from "./context.js"
import { BUILTIN_UPSTREAM_HOSTS, type Env } from "./env.js"

/**
 * Only administrators register upstream base URLs, and even then only HTTPS hosts from the allowlist.
 * Members can never influence the proxy target, which closes the gateway as an SSRF vector.
 */
export async function validateUpstreamBaseURL(env: Env, input: string) {
  const url = parse(input)
  const extra = env.TEAMOS_UPSTREAM_HOST_ALLOWLIST.split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
  const host = url.hostname.toLowerCase()
  const allowlisted = BUILTIN_UPSTREAM_HOSTS.includes(host) || extra.includes(host)
  if (url.username || url.password) throw new ApiError(422, "invalid_upstream", "Base URL must not embed credentials")
  if (url.search || url.hash) throw new ApiError(422, "invalid_upstream", "Base URL must not include a query or fragment")
  if (env.TEAMOS_ALLOW_PRIVATE_UPSTREAMS) {
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new ApiError(422, "invalid_upstream", "Unsupported scheme")
    return normalize(url)
  }
  if (url.protocol !== "https:") throw new ApiError(422, "invalid_upstream", "Upstream base URL must use HTTPS")
  if (!allowlisted)
    throw new ApiError(422, "invalid_upstream", `Host ${host} is not in the upstream allowlist (SAORSA_UPSTREAM_HOST_ALLOWLIST)`)
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => [])
  if (addresses.length === 0) throw new ApiError(422, "invalid_upstream", `Host ${host} does not resolve`)
  if (addresses.some((entry) => isPrivateAddress(entry.address)))
    throw new ApiError(422, "invalid_upstream", `Host ${host} resolves to a private address`)
  return normalize(url)
}

function parse(input: string) {
  try {
    return new URL(input)
  } catch {
    throw new ApiError(422, "invalid_upstream", "Base URL is not a valid URL")
  }
}

function normalize(url: URL) {
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

export function isPrivateAddress(address: string) {
  if (address.includes(":")) {
    const lower = address.toLowerCase()
    return (
      lower === "::1" ||
      lower === "::" ||
      lower.startsWith("fc") ||
      lower.startsWith("fd") ||
      lower.startsWith("fe80") ||
      lower.startsWith("::ffff:127.") ||
      lower.startsWith("::ffff:10.") ||
      lower.startsWith("::ffff:192.168.")
    )
  }
  const [a = 0, b = 0] = address.split(".").map(Number)
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}
