import { randomBytes } from "node:crypto"
import { connect, migrate } from "./db.js"

const command = process.argv[2]

if (command === "migrate") {
  const url = process.env.SAORSA_DATABASE_URL ?? process.env.NEXCODE_DATABASE_URL ?? process.env.TEAMOS_DATABASE_URL
  if (!url) throw new Error("SAORSA_DATABASE_URL is required")
  const sql = connect(url)
  const applied = await migrate(sql)
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date")
  await sql.close()
} else if (command === "gen-master-key") {
  console.log(randomBytes(32).toString("base64"))
} else if (command === "gen-bootstrap-token") {
  console.log(randomBytes(32).toString("base64url"))
} else {
  console.log("usage: bun src/cli.ts <migrate|gen-master-key|gen-bootstrap-token>")
  process.exit(command ? 1 : 0)
}
