import { SQL } from "bun"
import path from "node:path"
import { readdir } from "node:fs/promises"

export type Sql = SQL

export function connect(url: string) {
  return new SQL(url, { max: 20, idleTimeout: 30 })
}

const migrationsDir = path.join(import.meta.dir, "..", "migrations")

/**
 * Applies pending SQL migrations in filename order inside one transaction each.
 * Checksums are recorded so an edited, already-applied migration is detected instead of silently diverging.
 */
export async function migrate(sql: Sql) {
  await sql`create table if not exists schema_migrations (
    version text primary key,
    checksum text not null,
    applied_at timestamptz not null default now()
  )`
  const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).toSorted()
  const applied = new Map<string, string>(
    (await sql`select version, checksum from schema_migrations`).map((row: { version: string; checksum: string }) => [
      row.version,
      row.checksum,
    ]),
  )
  const ran: string[] = []
  for (const file of files) {
    const text = await Bun.file(path.join(migrationsDir, file)).text()
    const checksum = new Bun.CryptoHasher("sha256").update(text).digest("hex")
    const existing = applied.get(file)
    if (existing) {
      if (existing !== checksum) throw new Error(`Migration ${file} changed after it was applied`)
      continue
    }
    await sql.begin(async (tx) => {
      // Serialize concurrent migrators (e.g. several replicas starting at once).
      await tx`select pg_advisory_xact_lock(7438201)`
      const [already] = await tx`select 1 from schema_migrations where version = ${file}`
      if (already) return
      await tx.unsafe(text)
      await tx`insert into schema_migrations (version, checksum) values (${file}, ${checksum})`
    })
    ran.push(file)
  }
  return ran
}

/** Bun.SQL returns int8 as strings; money and token totals are converted at the edge. */
export const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value))
export const big = (value: unknown) => (value === null || value === undefined ? 0n : BigInt(value as string))
