import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { paths } from "./paths.js"

/**
 * The only member file the Launcher ever edits is Gemini CLI's settings.json (one key: API-key auth), because
 * Gemini CLI ignores settings files it does not consider safe. Every other tool gets Saorsa settings through
 * the launched process's environment and arguments, so nothing on disk changes.
 *
 * Before editing, the original file is copied to the Launcher's backups, and managed.json records the key it
 * set and the value it replaced. `restore` puts that one value back and leaves anything else the member changed
 * since then untouched; the backup copy stays available for manual recovery.
 */
export interface ManagedChange {
  file: string
  key: string[]
  previous: unknown
  value: unknown
  backup: string | null
  at: string
}

type ManagedState = Record<string, ManagedChange>

// Gemini CLI reads ~/.gemini/settings.json from the home directory; SAORSA_GEMINI_SETTINGS overrides it in tests.
export const geminiSettingsFile = () => process.env.SAORSA_GEMINI_SETTINGS ?? path.join(homedir(), ".gemini", "settings.json")
const GEMINI_KEY = ["security", "auth", "selectedType"]
const GEMINI_VALUE = "gemini-api-key"

export async function readState(): Promise<ManagedState> {
  return JSON.parse((await readFile(paths.state(), "utf8").catch(() => "{}")) || "{}") as ManagedState
}

async function writeState(state: ManagedState) {
  await mkdir(path.dirname(paths.state()), { recursive: true })
  await writeFile(paths.state(), JSON.stringify(state, null, 2), { mode: 0o600 })
}

/** What configuring Gemini CLI would change, for the consent prompt. */
export async function geminiPlan() {
  const file = geminiSettingsFile()
  const current = await readJSON(file)
  if (current === "invalid") return { ok: false as const, file, error: `${file} 不是有效的 JSON，Launcher 不会修改它。请修复后重试。` }
  const previous = getPath(current ?? {}, GEMINI_KEY)
  return { ok: true as const, file, previous, alreadySet: previous === GEMINI_VALUE }
}

export async function configureGemini() {
  const plan = await geminiPlan()
  if (!plan.ok) throw new Error(plan.error)
  if (plan.alreadySet) return { changed: false, file: plan.file }
  const current = ((await readJSON(plan.file)) as Record<string, unknown> | undefined) ?? {}
  const backup = await backupFile("gemini-cli", plan.file)
  await writeAtomically(plan.file, `${JSON.stringify(setPath(current, GEMINI_KEY, GEMINI_VALUE), null, 2)}\n`)
  const state = await readState()
  state["gemini-cli"] = { file: plan.file, key: GEMINI_KEY, previous: plan.previous ?? null, value: GEMINI_VALUE, backup, at: new Date().toISOString() }
  await writeState(state)
  return { changed: true, file: plan.file, backup }
}

/** Reverts the single value the Launcher set, only if it is still the value the Launcher wrote. */
export async function restore(toolID: string) {
  const state = await readState()
  const change = state[toolID]
  if (!change) return { restored: false as const, reason: "Launcher 没有修改过该工具的配置" }
  const current = await readJSON(change.file)
  if (current === "invalid") return { restored: false as const, reason: `${change.file} 当前不是有效 JSON；备份在 ${change.backup ?? "（原文件不存在）"}` }
  if (getPath(current ?? {}, change.key) !== change.value) {
    delete state[toolID]
    await writeState(state)
    return { restored: false as const, reason: "该设置已被修改为其他值，Launcher 不覆盖你的改动" }
  }
  await writeAtomically(change.file, `${JSON.stringify(setPath((current as Record<string, unknown>) ?? {}, change.key, change.previous ?? undefined), null, 2)}\n`)
  delete state[toolID]
  await writeState(state)
  return { restored: true as const, file: change.file, backup: change.backup }
}

export async function isConfigured(toolID: string) {
  if (toolID !== "gemini-cli") return false
  const current = await readJSON(geminiSettingsFile())
  return current !== "invalid" && getPath(current ?? {}, GEMINI_KEY) === GEMINI_VALUE
}

async function readJSON(file: string): Promise<Record<string, unknown> | undefined | "invalid"> {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined || !text.trim()) return undefined
  try {
    const value = JSON.parse(text)
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : "invalid"
  } catch {
    return "invalid"
  }
}

async function backupFile(toolID: string, file: string) {
  const exists = await readFile(file).then(() => true).catch(() => false)
  if (!exists) return null
  const target = path.join(paths.backups(), toolID, `${new Date().toISOString().replace(/[:.]/g, "-")}-${path.basename(file)}`)
  await mkdir(path.dirname(target), { recursive: true })
  await copyFile(file, target)
  return target
}

async function writeAtomically(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.saorsa-tmp`
  await writeFile(temporary, content)
  await rename(temporary, file)
}

function getPath(object: Record<string, unknown>, key: string[]): unknown {
  return key.reduce<unknown>((value, part) => (value && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined), object)
}

/** Returns a copy with `key` set (or removed, with emptied parents, when value is undefined); siblings are preserved. */
export function setPath(object: Record<string, unknown>, key: string[], value: unknown): Record<string, unknown> {
  const [head, ...rest] = key
  if (head === undefined) return object
  const copy = { ...object }
  if (!rest.length) {
    if (value === undefined) delete copy[head]
    else copy[head] = value
    return copy
  }
  const child = copy[head] && typeof copy[head] === "object" && !Array.isArray(copy[head]) ? (copy[head] as Record<string, unknown>) : {}
  const updated = setPath(child, rest, value)
  // Removing the value Saorsa added should not leave behind empty objects Saorsa created around it.
  if (value === undefined && !Object.keys(updated).length) delete copy[head]
  else copy[head] = updated
  return copy
}
