import { RedisClient } from "bun"
import { createApp } from "./app.js"
import { SecretBox } from "./crypto.js"
import { connect, migrate } from "./db.js"
import { loadEnv } from "./env.js"
import { createLogger } from "./log.js"
import { startMaintenance } from "./maintenance.js"
import { createRealtime } from "./realtime.js"
import { createLimiter } from "./ratelimit.js"

const env = loadEnv()
const log = createLogger(env.TEAMOS_LOG_LEVEL)
const sql = connect(env.TEAMOS_DATABASE_URL)
const applied = await migrate(sql)
if (applied.length) log.info("migrations applied", { applied })
const redis = new RedisClient(env.TEAMOS_REDIS_URL)
const deps = {
  sql,
  redis,
  env,
  box: new SecretBox(env.TEAMOS_MASTER_KEYS, env.TEAMOS_MASTER_KEY_ACTIVE),
  realtime: await createRealtime(redis, log),
  limiter: createLimiter(redis),
  log,
  fetch: globalThis.fetch,
}
const app = createApp(deps)
const stop = startMaintenance(deps)
// Bodies above the gateway's 20MB request limit are refused before they are buffered.
const server = Bun.serve({ port: env.TEAMOS_PORT, hostname: env.TEAMOS_HOST, fetch: app.fetch, idleTimeout: 255, maxRequestBodySize: 24 * 1024 * 1024 })
log.info("Saorsa server listening", { url: `http://${server.hostname}:${server.port}`, public: env.TEAMOS_PUBLIC_URL })

const [admin] = await sql`select 1 from users where account_type = 'ADMIN' and deleted_at is null`
if (!admin) log.warn("Saorsa is not initialized: open the web console and complete setup with SAORSA_BOOTSTRAP_TOKEN")

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, async () => {
    log.info("shutting down", { signal })
    stop()
    await server.stop()
    await deps.realtime.close()
    redis.close()
    await sql.close()
    process.exit(0)
  })
