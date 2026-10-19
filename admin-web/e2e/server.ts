/**
 * E2E backend: a real Saorsa server (fresh `teamos_e2e` database, Redis db 2) plus the TEST-labelled mock
 * upstream, serving the built admin web. Started by Playwright's webServer; the bootstrap token is handed to
 * the specs through e2e/.state.json (git-ignored).
 */
import { RedisClient } from "bun"
import { randomBytes } from "node:crypto"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createApp } from "../../server/src/app.js"
import { SecretBox } from "../../server/src/crypto.js"
import { connect, migrate } from "../../server/src/db.js"
import { loadEnv } from "../../server/src/env.js"
import { createLogger } from "../../server/src/log.js"
import { createLimiter } from "../../server/src/ratelimit.js"
import { createRealtime } from "../../server/src/realtime.js"
import { startMockUpstream } from "../../server/src/mock-upstream.js"

const port = Number(process.env.E2E_PORT ?? 18790)
const origin = `http://127.0.0.1:${port}`
const bootstrapToken = randomBytes(24).toString("base64url")
// Stand-in Launcher builds so the tool center shows its install card.
const downloads = await mkdtemp(path.join(tmpdir(), "saorsa-e2e-downloads-"))
for (const name of ["saorsa-windows-x64.exe", "saorsa-macos-arm64", "saorsa-macos-x64"]) {
  const content = `e2e ${name}`
  await writeFile(path.join(downloads, name), content)
  await writeFile(path.join(downloads, `${name}.sha256`), `${new Bun.CryptoHasher("sha256").update(content).digest("hex")}  ${name}\n`)
}
await writeFile(path.join(downloads, "VERSION"), "0.1.0\n")
const env = loadEnv({
  TEAMOS_DATABASE_URL: process.env.TEAMOS_E2E_DATABASE_URL ?? "postgres://teamos@127.0.0.1:55432/teamos_e2e",
  TEAMOS_REDIS_URL: process.env.TEAMOS_E2E_REDIS_URL ?? "redis://127.0.0.1:56379/2",
  TEAMOS_MASTER_KEYS: `1:${randomBytes(32).toString("base64")}`,
  TEAMOS_BOOTSTRAP_TOKEN: bootstrapToken,
  TEAMOS_ALLOW_PRIVATE_UPSTREAMS: "true",
  TEAMOS_PUBLIC_URL: origin,
  TEAMOS_ADMIN_WEB_DIST: path.join(import.meta.dir, "..", "dist"),
  TEAMOS_DOWNLOADS_DIR: downloads,
  TEAMOS_LOG_LEVEL: "warn",
})
const sql = connect(env.TEAMOS_DATABASE_URL)
await sql.unsafe("drop schema public cascade; create schema public;")
await migrate(sql)
const redis = new RedisClient(env.TEAMOS_REDIS_URL)
await redis.send("FLUSHDB", [])
const mock = startMockUpstream(Number(process.env.E2E_MOCK_PORT ?? 18791))
const log = createLogger("warn")
const app = createApp({
  sql,
  redis,
  env,
  box: new SecretBox(env.TEAMOS_MASTER_KEYS, 1),
  realtime: await createRealtime(redis, log),
  limiter: createLimiter(redis),
  log,
  fetch: globalThis.fetch,
})
await Bun.write(path.join(import.meta.dir, ".state.json"), JSON.stringify({ origin, bootstrapToken, mockURL: mock.url }))
Bun.serve({ port, hostname: "127.0.0.1", fetch: app.fetch, idleTimeout: 120 })
console.log(`[e2e] Saorsa on ${origin}, mock upstream (TEST) on ${mock.url}`)
