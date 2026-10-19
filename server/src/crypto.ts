import { createCipheriv, createDecipheriv, randomBytes, createHash, timingSafeEqual } from "node:crypto"

/**
 * AES-256-GCM envelope for provider API keys. Master keys come from the environment (or a KMS-backed
 * secret mounted as env), never from the database, so a database dump alone does not reveal upstream keys.
 */
export class SecretBox {
  private readonly keys: Map<number, Buffer>

  constructor(
    spec: string,
    readonly activeVersion: number,
  ) {
    this.keys = new Map(
      spec
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const separator = part.indexOf(":")
          if (separator < 1) throw new Error("SAORSA_MASTER_KEYS entries must be version:base64key")
          const version = Number(part.slice(0, separator))
          const key = Buffer.from(part.slice(separator + 1), "base64")
          if (!Number.isInteger(version) || version < 1) throw new Error("Master key version must be a positive integer")
          if (key.length !== 32) throw new Error(`Master key ${version} must decode to 32 bytes`)
          return [version, key] as const
        }),
    )
    if (!this.keys.has(activeVersion)) throw new Error(`Active master key version ${activeVersion} is not configured`)
  }

  encrypt(plaintext: string, aad: string) {
    const nonce = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.activeVersion)!, nonce)
    cipher.setAAD(Buffer.from(aad))
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()])
    return { ciphertext: body, nonce, keyVersion: this.activeVersion }
  }

  decrypt(input: { ciphertext: Uint8Array; nonce: Uint8Array; keyVersion: number }, aad: string) {
    const key = this.keys.get(input.keyVersion)
    if (!key) throw new Error(`Master key version ${input.keyVersion} is not available`)
    const body = Buffer.from(input.ciphertext)
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(input.nonce))
    decipher.setAAD(Buffer.from(aad))
    decipher.setAuthTag(body.subarray(body.length - 16))
    return Buffer.concat([decipher.update(body.subarray(0, body.length - 16)), decipher.final()]).toString("utf8")
  }
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

export function randomToken(prefix: string, bytes = 32) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`
}

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Shown in place of a secret: never more than the last four characters. */
export function maskSecret(last4: string) {
  return `••••••••${last4}`
}

/** Human friendly device code: 8 chars from an alphabet without ambiguous glyphs. */
export function userCode() {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ23456789"
  const bytes = randomBytes(8)
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length])
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`
}
