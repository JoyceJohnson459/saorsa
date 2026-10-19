/**
 * Deterministic secret detectors. Each pattern is explainable on its own, which is what lets a
 * secret-leak risk event cite concrete evidence instead of an opaque model judgement.
 */
export const SECRET_PATTERNS: ReadonlyArray<{ id: string; label: string; pattern: RegExp }> = [
  // The whole block (or everything after an unterminated header) is the secret, not just the header line.
  {
    id: "private_key",
    label: "PEM private key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----|$)/g,
  },
  { id: "aws_access_key", label: "AWS access key ID", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "openai_key", label: "OpenAI-style API key", pattern: /\bsk-(?:proj-|live-|ant-api\d\d-)?[A-Za-z0-9_-]{20,}\b/g },
  { id: "anthropic_key", label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: "github_token", label: "GitHub token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { id: "slack_token", label: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "google_api_key", label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: "jwt", label: "JSON Web Token", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    id: "connection_string",
    label: "Credentialed connection string",
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:[^\s@/]{3,}@[^\s]+/g,
  },
  { id: "teamos_token", label: "Saorsa token", pattern: /\btos_(?:at|rt|dc)_[A-Za-z0-9_-]{20,}\b/g },
]

export interface SecretFinding {
  id: string
  label: string
  /** sha256 prefix of the matched value: stable for de-duplication, useless for recovering the secret. */
  fingerprint: string
  /** Redacted excerpt with the secret replaced; at most ~80 chars of surrounding context. */
  excerpt: string
}

export function findSecrets(text: string): SecretFinding[] {
  const findings = new Map<string, SecretFinding>()
  for (const detector of SECRET_PATTERNS) {
    for (const match of text.matchAll(detector.pattern)) {
      const value = match[0]
      const fingerprint = new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16)
      if (findings.has(fingerprint)) continue
      const start = Math.max(0, (match.index ?? 0) - 40)
      const end = Math.min(text.length, (match.index ?? 0) + value.length + 40)
      findings.set(fingerprint, {
        id: detector.id,
        label: detector.label,
        fingerprint,
        excerpt: redactSecrets(text.slice(start, end)).replace(/\s+/g, " ").trim(),
      })
    }
  }
  return [...findings.values()]
}

export function redactSecrets(text: string) {
  return SECRET_PATTERNS.reduce(
    (current, detector) =>
      current.replace(detector.pattern, (value) =>
        detector.id === "private_key" ? "[REDACTED PRIVATE KEY]" : `[REDACTED ${detector.id}:${value.slice(-4)}]`,
      ),
    text,
  ).replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1[REDACTED]")
}

/** Removes secrets from arbitrary log/audit metadata before it is persisted or printed. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]"
  if (typeof value === "string") return redactSecrets(value)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /(?:api[_-]?key|secret|password|token|authorization|cookie)/i.test(key) ? "[REDACTED]" : redactValue(item, depth + 1),
      ]),
    )
  }
  return value
}
