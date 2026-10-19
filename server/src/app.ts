import { Hono } from "hono"
import { serveStatic } from "hono/bun"
import { ZodError } from "zod"
import path from "node:path"
import { ApiError, type AppEnv, type Deps } from "./context.js"
import { requireAdmin, requireAuth } from "./auth.js"
import { gatewayRoutes } from "./gateway.js"
import { authRoutes } from "./routes/auth.js"
import { consoleRoutes } from "./routes/console.js"
import { meRoutes } from "./routes/me.js"
import { adminOrgRoutes } from "./routes/admin-org.js"
import { adminModelRoutes } from "./routes/admin-models.js"
import { adminOpsRoutes } from "./routes/admin-ops.js"
import { toolRoutes } from "./routes/tools.js"
import { launcherRoutes } from "./routes/launcher.js"
import { downloadRoutes } from "./routes/downloads.js"
import { mcpRoutes } from "./routes/mcp.js"
import { opencodeRoutes } from "./routes/opencode.js"
import { openAPI } from "./openapi.js"

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>()

  app.use("*", async (c, next) => {
    const requestID = `req_${crypto.randomUUID().replaceAll("-", "")}`
    c.set("deps", deps)
    c.set("requestID", requestID)
    const started = performance.now()
    await next()
    c.header("x-request-id", requestID)
    c.header("x-content-type-options", "nosniff")
    c.header("referrer-policy", "same-origin")
    if (!c.req.path.startsWith("/gateway/"))
      c.header(
        "content-security-policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      )
    deps.log.debug("http", { method: c.req.method, path: c.req.path, status: c.res.status, ms: Math.round(performance.now() - started), requestID })
  })

  app.onError((error, c) => {
    const requestID = c.get("requestID")
    if (error instanceof ApiError)
      return c.json({ error: { code: error.code, message: error.message, request_id: requestID } }, error.status, error.headers)
    if (error instanceof ZodError)
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
            request_id: requestID,
          },
        },
        422,
      )
    if (error instanceof SyntaxError) return c.json({ error: { code: "invalid_json", message: "Malformed JSON body", request_id: requestID } }, 400)
    deps.log.error("unhandled error", { requestID, path: c.req.path, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) })
    return c.json({ error: { code: "internal_error", message: "Internal server error", request_id: requestID } }, 500)
  })

  app.get("/healthz", (c) => c.json({ ok: true }))
  app.get("/readyz", async (c) => {
    await deps.sql`select 1`
    await deps.redis.send("PING", [])
    return c.json({ ok: true })
  })
  app.get("/api/openapi.json", (c) => c.json(openAPI))

  authRoutes(app)
  consoleRoutes(app)
  opencodeRoutes(app)
  gatewayRoutes(app)
  mcpRoutes(app)
  meRoutes(app)
  app.use("/api/admin/*", requireAuth, requireAdmin)
  adminOrgRoutes(app)
  adminModelRoutes(app)
  adminOpsRoutes(app)
  toolRoutes(app)
  launcherRoutes(app)
  downloadRoutes(app)

  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "Unknown API route", request_id: c.get("requestID") } }, 404))

  const dist = deps.env.TEAMOS_ADMIN_WEB_DIST ?? path.join(import.meta.dir, "..", "..", "admin-web", "dist")
  app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), dist) }))
  // SPA fallback: every non-API route renders the console shell (including /device for OpenCode logins).
  app.get("*", async (c) => {
    const index = Bun.file(path.join(dist, "index.html"))
    if (!(await index.exists())) return c.text("Saorsa admin web is not built. Run `bun run build` in the repository root.", 503)
    return c.html(await index.text())
  })
  return app
}
