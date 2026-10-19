import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { paths } from "./paths.js"

/**
 * The Launcher session token lives in the OS credential store: the macOS Keychain, Windows DPAPI (encrypted for
 * the current Windows user), or the Secret Service on Linux. It is passed on stdin, never on a command line, so
 * it does not appear in process listings. Without a credential store (headless Linux) it falls back to a 0600
 * file and says so.
 *
 * SAORSA_KEYCHAIN points macOS at another keychain file (tests use a throwaway keychain).
 */
const SERVICE = "Saorsa Launcher"

export interface SecretStore {
  kind: string
  get(account: string): Promise<string | undefined>
  set(account: string, secret: string): Promise<void>
  delete(account: string): Promise<void>
}

export function secretStore(): SecretStore {
  if (process.env.SAORSA_SECRET_FILE) return fileStore(process.env.SAORSA_SECRET_FILE)
  if (process.platform === "darwin") return keychain(process.env.SAORSA_KEYCHAIN)
  if (process.platform === "win32") return dpapi()
  if (Bun.which("secret-tool")) return secretService()
  return fileStore(path.join(path.dirname(paths.config()), "credential"), true)
}

async function run(command: string[], stdin?: string) {
  const child = Bun.spawn(command, { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" })
  if (stdin !== undefined && child.stdin) {
    child.stdin.write(stdin)
    await child.stdin.end()
  }
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { stdout, stderr, code }
}

function keychain(file: string | undefined): SecretStore {
  const target = file ? [file] : []
  // `security -i` reads commands from stdin; quoting follows its shell-like parser.
  const quote = (value: string) => `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`
  return {
    kind: "macOS Keychain",
    async get(account) {
      const result = await run(["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w", ...target])
      return result.code === 0 ? result.stdout.trim() : undefined
    },
    async set(account, secret) {
      const result = await run(["security", "-i"], `add-generic-password -U -s ${quote(SERVICE)} -a ${quote(account)} -w ${quote(secret)} ${target.map(quote).join(" ")}\n`)
      if (result.code !== 0 || /error/i.test(result.stderr)) throw new Error(`Keychain write failed: ${result.stderr.trim()}`)
    },
    async delete(account) {
      await run(["security", "delete-generic-password", "-s", SERVICE, "-a", account, ...target])
    },
  }
}

function dpapi(): SecretStore {
  const file = paths.windowsCredential()
  const powershell = (script: string, stdin?: string) => run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], stdin)
  return {
    kind: "Windows DPAPI (current user)",
    async get() {
      const result = await powershell(
        `$s = Get-Content -LiteralPath '${file}' -ErrorAction Stop | ConvertTo-SecureString; [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))`,
      )
      return result.code === 0 ? result.stdout.trim() || undefined : undefined
    },
    async set(_account, secret) {
      await mkdir(path.dirname(file), { recursive: true })
      const result = await powershell(
        `$t = [Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString $t -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath '${file}'`,
        secret,
      )
      if (result.code !== 0) throw new Error(`DPAPI write failed: ${result.stderr.trim()}`)
    },
    async delete() {
      await rm(file, { force: true })
    },
  }
}

function secretService(): SecretStore {
  return {
    kind: "Secret Service",
    async get(account) {
      const result = await run(["secret-tool", "lookup", "service", SERVICE, "account", account])
      return result.code === 0 ? result.stdout.trim() || undefined : undefined
    },
    async set(account, secret) {
      const result = await run(["secret-tool", "store", `--label=${SERVICE}`, "service", SERVICE, "account", account], secret)
      if (result.code !== 0) throw new Error(`Secret Service write failed: ${result.stderr.trim()}`)
    },
    async delete(account) {
      await run(["secret-tool", "clear", "service", SERVICE, "account", account])
    },
  }
}

function fileStore(file: string, fallback = false): SecretStore {
  return {
    kind: fallback ? "file (0600; no OS credential store found)" : "file",
    async get() {
      return (await readFile(file, "utf8").catch(() => "")).trim() || undefined
    },
    async set(_account, secret) {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, secret, { mode: 0o600 })
      await chmod(file, 0o600)
    },
    async delete() {
      await rm(file, { force: true })
    },
  }
}
