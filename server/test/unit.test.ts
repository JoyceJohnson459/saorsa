import { describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { SecretBox, userCode } from "../src/crypto.js"
import { loadEnv } from "../src/env.js"
import { billableLines, estimateCeiling, lineCost, type PriceVersion } from "../src/pricing.js"
import { findSecrets, redactSecrets, redactValue } from "../src/redact.js"
import { parseMicros } from "../src/routes/admin-models.js"
import { keywordRelevance, trailingMessages } from "../src/risk.js"
import { toCSV } from "../src/usage.js"
import { isPrivateAddress } from "../src/upstream.js"

const price: PriceVersion = { id: "p", currency: "USD", input: 3_000_000n, output: 15_000_000n, cacheRead: 300_000n, cacheWrite: 3_750_000n, reasoning: undefined }

describe("money", () => {
  test("parses decimal prices into integer micros without floating point", () => {
    expect(parseMicros("3")).toBe(3_000_000n)
    expect(parseMicros("0.15")).toBe(150_000n)
    expect(parseMicros("0.000001")).toBe(1n)
    expect(parseMicros(12.5)).toBe(12_500_000n)
    expect(() => parseMicros("1.0000001")).toThrow()
    expect(() => parseMicros("-1")).toThrow()
    expect(() => parseMicros("1e3")).toThrow()
  })

  test("line cost rounds half up per line", () => {
    expect(lineCost(1_000_000, 3_000_000n)).toBe(3_000_000n)
    expect(lineCost(1, 3_000_000n)).toBe(3n)
    expect(lineCost(1, 400_000n)).toBe(0n)
    expect(lineCost(1, 500_000n)).toBe(1n)
  })

  test("cached and reasoning subsets are carved out, never double billed", () => {
    const lines = billableLines({ input: 1000, output: 500, cacheRead: 400, cacheWrite: 0, reasoning: 200 }, price)
    const byCategory = Object.fromEntries(lines.map((line) => [line.category, line.tokens]))
    expect(byCategory).toEqual({ input: 600, output: 300, cache_read: 400, reasoning: 200 })
    const total = lines.reduce((sum, line) => sum + line.cost, 0n)
    // 600*3 + 300*15 + 400*0.3 + 200*15 (reasoning at output price) micros per token / 1e6 * 1e6
    expect(total).toBe(1800n + 4500n + 120n + 3000n)
  })

  test("reservation ceiling covers the full output allowance", () => {
    expect(estimateCeiling({ requestBytes: 3000, maxOutputTokens: 1000 }, price)).toBe(3000n + 15000n)
  })
})

describe("secrets", () => {
  test("detects and redacts common credential formats", () => {
    const text = [
      "aws AKIAABCDEFGHIJKLMNOP",
      "openai sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "gh ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "db postgres://app:hunter22@db.internal:5432/prod",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----",
    ].join("\n")
    const findings = findSecrets(text)
    expect(findings.map((finding) => finding.id).toSorted()).toEqual(
      ["aws_access_key", "connection_string", "github_token", "openai_key", "private_key"].toSorted(),
    )
    const redacted = redactSecrets(text)
    for (const raw of ["AKIAABCDEFGHIJKLMNOP", "hunter22", "b3BlbnNzaC1rZXktdjEAAAAA", "abcdefghijklmnopqrstuvwxyz0123456789"])
      expect(redacted).not.toContain(raw)
    for (const finding of findings) expect(finding.excerpt).not.toContain("b3BlbnNzaC1rZXktdjEAAAAA")
  })

  test("an unterminated private key block is redacted to the end", () => {
    expect(redactSecrets("x -----BEGIN PRIVATE KEY-----\nMIIsecretbody")).toBe("x [REDACTED PRIVATE KEY]")
  })

  test("structured metadata hides sensitive keys and bearer tokens", () => {
    expect(redactValue({ apiKey: "abc", nested: { password: "p", note: "Bearer abcdefghijklmnop" }, ok: 1 })).toEqual({
      apiKey: "[REDACTED]",
      nested: { password: "[REDACTED]", note: "Bearer [REDACTED]" },
      ok: 1,
    })
  })

  test("only content after the last assistant turn is re-scanned", () => {
    const messages = [
      { role: "user", content: "old AKIAABCDEFGHIJKLMNOP" },
      { role: "assistant", content: "ok" },
      { role: "tool", content: "new" },
    ]
    expect(trailingMessages(messages)).toEqual([{ role: "tool", content: "new" }])
  })
})

describe("crypto", () => {
  test("AES-GCM round trip, AAD binding and key versions", () => {
    const k1 = randomBytes(32).toString("base64")
    const k2 = randomBytes(32).toString("base64")
    const v1 = new SecretBox(`1:${k1}`, 1)
    const sealed = v1.encrypt("sk-real-secret", "cred-1")
    expect(v1.decrypt(sealed, "cred-1")).toBe("sk-real-secret")
    expect(() => v1.decrypt(sealed, "cred-2")).toThrow()
    const both = new SecretBox(`1:${k1},2:${k2}`, 2)
    expect(both.decrypt(sealed, "cred-1")).toBe("sk-real-secret")
    expect(both.encrypt("x", "a").keyVersion).toBe(2)
    expect(() => new SecretBox("1:short", 1)).toThrow("32 bytes")
  })

  test("device user codes avoid ambiguous characters", () => {
    for (let index = 0; index < 50; index++) expect(userCode()).toMatch(/^[B-DF-HJ-NP-TV-XZ2-9]{4}-[B-DF-HJ-NP-TV-XZ2-9]{4}$/)
  })
})

describe("misc", () => {
  test("CSV export neutralizes spreadsheet formulas and quotes", () => {
    expect(toCSV([{ a: "=cmd()", b: 'x,"y"' }], ["a", "b"])).toBe(`a,b\n'=cmd(),"x,""y"""`)
  })

  test("private address detection", () => {
    for (const address of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.1", "192.168.1.1", "::1", "fd00::1"])
      expect(isPrivateAddress(address)).toBe(true)
    for (const address of ["8.8.8.8", "104.18.6.192"]) expect(isPrivateAddress(address)).toBe(false)
  })

  test("keyword relevance is a weak, explainable signal", () => {
    const project = { name: "Alpha Vision", purpose: "defect detection image preprocessing training", description: "", tags: ["pytorch"] }
    const related = keywordRelevance("Improve the image preprocessing step used in defect detection training with pytorch augmentations", project)
    const unrelated = keywordRelevance("Plan my wedding seating chart and write romantic poems for the guests attending dinner", project)
    expect(related!.overlapRatio).toBeGreaterThan(unrelated!.overlapRatio)
    expect(unrelated!.matched).toEqual([])
    expect(keywordRelevance("too short", project)).toBeUndefined()
  })
})

describe("environment", () => {
  const required = { SAORSA_DATABASE_URL: "postgres://db", SAORSA_REDIS_URL: "redis://r", SAORSA_MASTER_KEYS: "1:k" }

  test("SAORSA_* names configure the server, override earlier NEXCODE_*/TEAMOS_* names, and appear in errors", () => {
    const env = loadEnv({ ...required, SAORSA_PORT: "9000", NEXCODE_PORT: "8500", TEAMOS_PORT: "8000", NEXCODE_LOG_LEVEL: "warn", TEAMOS_HOST: "0.0.0.0" })
    expect(env.TEAMOS_DATABASE_URL).toBe("postgres://db")
    expect(env.TEAMOS_PORT).toBe(9000)
    expect(env.TEAMOS_LOG_LEVEL).toBe("warn")
    expect(env.TEAMOS_HOST).toBe("0.0.0.0")
    expect(() => loadEnv({ SAORSA_REDIS_URL: "redis://r", SAORSA_MASTER_KEYS: "1:k" })).toThrow("SAORSA_DATABASE_URL")
  })

  test("an empty variable counts as unset, as Compose passes ${NAME:-} for an omitted setting", () => {
    const env = loadEnv({ ...required, SAORSA_BOOTSTRAP_TOKEN: "", SAORSA_UPSTREAM_HOST_ALLOWLIST: "", SAORSA_LOG_LEVEL: "", TEAMOS_LOG_LEVEL: "warn" })
    expect(env.TEAMOS_BOOTSTRAP_TOKEN).toBeUndefined()
    expect(env.TEAMOS_UPSTREAM_HOST_ALLOWLIST).toBe("")
    expect(env.TEAMOS_LOG_LEVEL).toBe("warn")
    expect(() => loadEnv({ ...required, SAORSA_DATABASE_URL: "" })).toThrow("SAORSA_DATABASE_URL")
  })
})
