import { homedir } from "node:os"
import path from "node:path"

/**
 * Everything the Launcher writes lives under one directory it owns: config, logs, backups of files it edits and
 * the record of what it changed. SAORSA_HOME overrides it (tests, portable installs).
 */
export function saorsaHome() {
  if (process.env.SAORSA_HOME) return process.env.SAORSA_HOME
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(homedir(), "AppData", "Roaming"), "Saorsa")
  return path.join(homedir(), ".saorsa")
}

export const paths = {
  config: () => path.join(saorsaHome(), "config.json"),
  state: () => path.join(saorsaHome(), "managed.json"),
  log: () => path.join(saorsaHome(), "logs", "launcher.log"),
  backups: () => path.join(saorsaHome(), "backups"),
  windowsCredential: () => path.join(saorsaHome(), "credential.dpapi"),
}
