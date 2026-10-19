import type { LaunchRecipe, ToolProfile } from "../../catalog/tools.js"
import type { Me } from "./api.js"
import { detect, vscodeCLI } from "./detect.js"

/** Substitutes only the documented placeholders; values are passed as argv/env entries, never through a shell. */
export function fill(template: string, values: { origin: string; token: string; model: string; dir: string }) {
  return template
    .replaceAll("{origin}", values.origin)
    .replaceAll("{token}", values.token)
    .replaceAll("{model}", values.model)
    .replaceAll("{dir}", values.dir)
}

/**
 * The child process environment: the member's environment without the variables that would send a personal key
 * or pick another backend, plus the recipe's Saorsa settings. The token exists only in this environment.
 */
export function childEnvironment(recipe: Extract<LaunchRecipe, { kind: "process" }>, base: Record<string, string | undefined>, values: Parameters<typeof fill>[1]) {
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(base)) if (value !== undefined && !recipe.unsetEnv.includes(name)) env[name] = value
  for (const [name, value] of Object.entries(recipe.env)) env[name] = fill(value, values)
  return env
}

/** Chooses the billing project and model for a tool from what the member is entitled to. */
export function chooseTarget(me: Me, toolID: string, wanted: { project?: string; model?: string; defaultProjectID?: string }) {
  const entitled = me.projects.filter((project) => project.tools.some((tool) => tool.id === toolID))
  if (!entitled.length) throw new Error(`你的项目组没有授权该工具，请联系管理员`)
  const project = wanted.project
    ? entitled.find((candidate) => candidate.id === wanted.project || candidate.code.toLowerCase() === wanted.project!.toLowerCase())
    : (entitled.find((candidate) => candidate.id === wanted.defaultProjectID) ?? entitled[0])
  if (!project) throw new Error(`项目组 ${wanted.project} 未授权该工具；可选：${entitled.map((candidate) => candidate.code).join("、")}`)
  const models = project.tools.find((tool) => tool.id === toolID)!.models
  const model = wanted.model ? models.find((candidate) => candidate.alias === wanted.model) : models[0]
  if (!model)
    throw new Error(
      wanted.model
        ? `模型 ${wanted.model} 在项目组 ${project.code} 中不可用于该工具；可选：${models.map((candidate) => candidate.alias).join("、") || "无"}`
        : `项目组 ${project.code} 没有该工具可用的模型（需要该工具支持的协议），请联系管理员`,
    )
  return { project, model: model.alias, models }
}

/** The command that opens an IDE on a folder. */
export async function ideCommand(tool: ToolProfile, editor: Extract<LaunchRecipe, { kind: "ide" }>["editor"], dir: string) {
  if (editor === "vscode") {
    const code = vscodeCLI()
    return code ? [code, dir] : undefined
  }
  const found = await detect(tool)
  if (!found.installed || !found.location) return undefined
  return process.platform === "darwin" ? ["open", "-a", found.location, dir] : [found.location, dir]
}
