import type { Context, Hono } from "hono"
import type { AppEnv, Deps, Principal } from "../context.js"
import { bearer, clientIP, createTokenSession, endedReason, principalFromToken, throttleIP, touchClientSession } from "../auth.js"
import { randomToken, sha256, userCode } from "../crypto.js"
import { audit } from "../audit.js"
import { authorizedModels, servesProtocol } from "../gateway.js"
import { orgSettings } from "../settings.js"
import { ANTHROPIC_PROVIDER, MCP_SERVER, PROVIDER, TOKEN_ENV } from "../brand.js"

/**
 * Official OpenCode releases (1.x) support organization setup through `/.well-known/opencode`:
 *
 *   opencode auth login https://saorsa.tech
 *
 * runs the `auth.command` below (stdout = token) and stores the token under that exact URL. On every start
 * OpenCode re-fetches `<url>/.well-known/opencode` and `remote_config`, substituting `{env:NEXCODE_TOKEN}`, so providers, models, prices,
 * restrictions and the usage MCP server all come from Saorsa. Members keep updating OpenCode themselves;
 * only this server needs updating.
 *
 * OpenCode spawns `auth.command` without a shell, and Windows has no `sh`, so Windows members log in to
 * `<origin>/windows`, whose manifest runs the same device flow in Windows PowerShell 5.1+ instead.
 */
const REAUTH_MODEL = "login-required"
const DEVICE_TTL_SECONDS = 600

// POSIX sh + curl (macOS, Linux, WSL, Git Bash). Instructions go to stderr; only the token goes to stdout.
const LOGIN_SCRIPT = [
  'S="$1"',
  'R=$(curl -fsS -X POST "$S/cli/login") || { echo "无法连接 Saorsa：$S" >&2; exit 1; }',
  "set -- $R",
  'echo "请在浏览器中完成 Saorsa 授权（验证码 $3）：$2" >&2',
  '(open "$2" || xdg-open "$2") >/dev/null 2>&1 || true',
  "while sleep 3; do",
  '  T=$(curl -fsS -X POST --data "$1" "$S/cli/login/poll") || { echo "授权已过期或被拒绝，请重新运行登录命令。" >&2; exit 1; }',
  '  [ -n "$T" ] && { printf "%s" "$T"; exit 0; }',
  "done",
].join("\n")

const WINDOWS_LOGIN_PATH = "/windows"

// Windows PowerShell 5.1 (preinstalled since Windows 10) and PowerShell 7. Same contract as LOGIN_SCRIPT.
const windowsLoginScript = (origin: string) =>
  [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072",
    `$S = '${origin.replaceAll("'", "''")}'`,
    // Content is a string or a byte array depending on the PowerShell version, so decode the raw body.
    "function Post($Uri, $Body) { [Text.Encoding]::UTF8.GetString((Invoke-WebRequest -UseBasicParsing -Method Post -Uri $Uri -Body $Body).RawContentStream.ToArray()).Trim() }",
    "try { $R = (Post \"$S/cli/login\" '') -split ' ' } catch { [Console]::Error.WriteLine(\"无法连接 Saorsa：$S（$($_.Exception.Message)）\"); exit 1 }",
    "[Console]::Error.WriteLine(\"请在浏览器中完成 Saorsa 授权（验证码 $($R[2])）：$($R[1])\")",
    "try { Start-Process $R[1] } catch {}",
    "while ($true) {",
    "  Start-Sleep -Seconds 3",
    "  try { $T = Post \"$S/cli/login/poll\" $R[0] } catch { [Console]::Error.WriteLine('授权已过期或被拒绝，请重新运行登录命令。'); exit 1 }",
    "  if ($T) { [Console]::Out.Write($T); exit 0 }",
    "}",
  ].join("\n")

export function opencodeRoutes(app: Hono<AppEnv>) {
  app.get("/.well-known/opencode", (c) => {
    const origin = c.get("deps").env.TEAMOS_PUBLIC_URL
    return c.json(manifest(origin, ["sh", "-c", LOGIN_SCRIPT, "saorsa-login", origin]))
  })

  // -EncodedCommand (UTF-16LE base64) sidesteps Windows command-line quoting, which mangles inline scripts.
  app.get(`${WINDOWS_LOGIN_PATH}/.well-known/opencode`, (c) => {
    const origin = c.get("deps").env.TEAMOS_PUBLIC_URL
    const encoded = Buffer.from(windowsLoginScript(origin), "utf16le").toString("base64")
    return c.json(manifest(origin, ["powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]))
  })

  // Text responses keep the login script free of JSON parsing: "<device code> <approval URL> <user code>".
  app.post("/cli/login", async (c) => {
    const deps = c.get("deps")
    await throttleIP(c, "device-code", 20)
    const deviceCode = randomToken("tos_dc")
    const code = userCode()
    await deps.sql`insert into device_authorizations (device_code_hash, user_code, client_label, interval_seconds, expires_at)
      values (${sha256(deviceCode)}, ${code}, 'OpenCode', 3, now() + make_interval(secs => ${DEVICE_TTL_SECONDS}))`
    return c.text(`${deviceCode} ${deps.env.TEAMOS_PUBLIC_URL}/device?code=${encodeURIComponent(code)} ${code}`)
  })

  // 202 while pending, 200 with the token once approved (exactly once), 410 when expired, denied or used.
  app.post("/cli/login/poll", async (c) => {
    const deps = c.get("deps")
    await throttleIP(c, "device-token", 120)
    const deviceCode = (await c.req.text()).trim()
    if (!deviceCode) return c.body(null, 410)
    const approved = await deps.sql.begin(async (tx) => {
      const [row] = await tx`select id, status, user_id, project_id, expires_at from device_authorizations
        where device_code_hash = ${sha256(deviceCode)} for update`
      if (!row || new Date(row.expires_at) < new Date() || ["denied", "consumed", "expired"].includes(row.status)) return "gone" as const
      await tx`update device_authorizations set last_polled_at = now() where id = ${row.id}`
      if (row.status === "pending") return "pending" as const
      await tx`update device_authorizations set status = 'consumed', consumed_at = now() where id = ${row.id}`
      return row as { user_id: string; project_id: string }
    })
    if (approved === "gone") return c.body(null, 410)
    if (approved === "pending") return c.body(null, 202)
    const session = await createTokenSession(deps, {
      userID: approved.user_id,
      projectID: approved.project_id,
      deviceLabel: "OpenCode",
      userAgent: c.req.header("user-agent")?.slice(0, 256),
      ip: clientIP(c),
    })
    await audit(deps.sql, {
      actor: { userID: approved.user_id, accountType: "MEMBER" },
      actorType: "member",
      action: "client.session_created",
      targetType: "project",
      targetID: approved.project_id,
      metadata: { sessionID: session.sessionID, flow: "well-known" },
      ip: clientIP(c),
    })
    return c.text(session.access)
  })

  app.get("/api/opencode/config", async (c) => {
    const deps = c.get("deps")
    const principal = await clientPrincipal(c)
    if (!principal) {
      const token = bearer(c)?.token
      return reauthConfig(c, token && (await endedReason(deps, token)) ? "账号已在其他设备登录" : "Saorsa 登录已失效")
    }
    const [project] = await deps.sql`select p.id, p.code, p.name, p.status, exists(
        select 1 from project_members m where m.project_id = p.id and m.user_id = ${principal.userID}) as member
      from projects p where p.id = ${principal.projectID!}`
    if (!project || project.status !== "active" || !project.member) return reauthConfig(c, "当前计费项目组已不可用")
    await touchClientSession(deps, principal.sessionID)
    return c.json(await opencodeConfig(deps, project))
  })
}

function manifest(origin: string, command: string[]) {
  return {
    auth: { command, env: TOKEN_ENV },
    remote_config: { url: `${origin}/api/opencode/config`, headers: { authorization: `Bearer {env:${TOKEN_ENV}}` } },
  }
}

async function clientPrincipal(c: Context<AppEnv>): Promise<Principal | undefined> {
  const credential = bearer(c)
  if (!credential || credential.via !== "header") return undefined
  const principal = await principalFromToken(c.get("deps"), credential.token)
  return principal?.sessionKind === "client" && principal.projectID ? principal : undefined
}

/**
 * A rejected remote config would stop OpenCode from starting at all. Instead an expired or revoked login
 * yields a config whose only provider is named after the fix, with managed providers still enforced.
 */
async function reauthConfig(c: Context<AppEnv>, reason: string) {
  const deps = c.get("deps")
  const settings = await orgSettings(deps.sql)
  // A placeholder model keeps OpenCode usable: calling it reaches the gateway, whose 401 names the login command.
  return c.json({
    provider: {
      [PROVIDER]: {
        name: `Saorsa（${reason}）`,
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${deps.env.TEAMOS_PUBLIC_URL}/gateway/v1`, apiKey: `{env:${TOKEN_ENV}}` },
        models: { [REAUTH_MODEL]: { name: `请重新登录：opencode auth login ${deps.env.TEAMOS_PUBLIC_URL}（Windows 在末尾加 ${WINDOWS_LOGIN_PATH}）`, tool_call: false } },
      },
    },
    model: `${PROVIDER}/${REAUTH_MODEL}`,
    ...(settings.restrictToManagedProviders ? { enabled_providers: [PROVIDER, ANTHROPIC_PROVIDER] } : {}),
  })
}

/** Admin-entered text must never be able to introduce `{env:…}` or `{file:…}` substitutions on clients. */
const plain = (value: string) => value.replace(/[{}]/g, "")

export async function opencodeConfig(deps: Deps, project: { id: string; code: string; name: string }) {
  const origin = deps.env.TEAMOS_PUBLIC_URL
  const settings = await orgSettings(deps.sql)
  const models = await authorizedModels(deps, project.id, "opencode")
  const prices = await deps.sql`select distinct on (model_id) model_id, currency, input_per_mtok_micros, output_per_mtok_micros,
      cache_read_per_mtok_micros, cache_write_per_mtok_micros
    from pricing_versions where effective_from <= now() order by model_id, effective_from desc, created_at desc`
  const priceByModel = new Map<string, Record<string, string>>(prices.map((row: Record<string, string>) => [row.model_id!, row]))
  const perMillion = (micros: string | undefined) => Number(micros ?? 0) / 1_000_000
  const catalog = (protocol: string) =>
    Object.fromEntries(
      models
        .filter((model) => servesProtocol(model, protocol))
        .map((model) => {
          const price = priceByModel.get(model.id)
          return [
            model.alias,
            {
              name: `${plain(model.display_name)} (受管)`,
              tool_call: model.supports_tools,
              reasoning: model.supports_reasoning,
              ...(model.context_limit && model.output_limit ? { limit: { context: model.context_limit, output: model.output_limit } } : {}),
              // OpenCode only shows USD estimates; other currencies stay authoritative in Saorsa reports.
              ...(price?.currency === "USD"
                ? {
                    cost: {
                      input: perMillion(price.input_per_mtok_micros),
                      output: perMillion(price.output_per_mtok_micros),
                      cache_read: perMillion(price.cache_read_per_mtok_micros),
                      cache_write: perMillion(price.cache_write_per_mtok_micros),
                    },
                  }
                : {}),
            },
          ]
        }),
    )
  const openai = catalog("openai-chat")
  const anthropic = catalog("anthropic-messages")
  const label = plain(`${project.code} ${project.name}`)
  const first = Object.keys(openai)[0] ? `${PROVIDER}/${Object.keys(openai)[0]}` : Object.keys(anthropic)[0] ? `${ANTHROPIC_PROVIDER}/${Object.keys(anthropic)[0]}` : undefined
  return {
    provider: {
      [PROVIDER]: {
        name: `Saorsa · ${label}`,
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${origin}/gateway/v1`, apiKey: `{env:${TOKEN_ENV}}` },
        models: openai,
      },
      ...(Object.keys(anthropic).length
        ? {
            [ANTHROPIC_PROVIDER]: {
              name: `Saorsa Claude · ${label}`,
              npm: "@ai-sdk/anthropic",
              options: { baseURL: `${origin}/gateway/anthropic/v1`, apiKey: `{env:${TOKEN_ENV}}` },
              models: anthropic,
            },
          }
        : {}),
    },
    ...(first ? { model: first } : {}),
    // Hides every provider that does not go through the gateway in clients connected to Saorsa.
    ...(settings.restrictToManagedProviders ? { enabled_providers: [PROVIDER, ANTHROPIC_PROVIDER] } : {}),
    mcp: {
      [MCP_SERVER]: { type: "remote", url: `${origin}/mcp`, headers: { Authorization: `Bearer {env:${TOKEN_ENV}}` }, oauth: false },
    },
  }
}
