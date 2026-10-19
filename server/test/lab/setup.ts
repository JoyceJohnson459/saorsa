import { mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { MOCK_KEY } from "../../src/mock-upstream.js"
import { seedOrg, startHarness } from "../harness.js"

/**
 * Lab environment for real-tool verification: the real Saorsa server and gateway on a fresh test database,
 * the TEST-labelled mock upstream behind four providers (one per protocol), every catalog tool authorized for
 * the seed project, a Saorsa key per tool, and a scratch workspace holding the file the mock asks tools to read.
 */
export async function startLab() {
  const h = await startHarness()
  const org = await seedOrg(h)
  const provider = async (name: string, protocol: string, baseURL: string, extraProtocols: string[] = []) => {
    const id = (await org.admin.post("/api/admin/providers", { name, protocol, baseURL, extraProtocols })).json.id as string
    await org.admin.post(`/api/admin/providers/${id}/credentials`, { label: "primary", apiKey: MOCK_KEY })
    return id
  }
  const model = async (providerID: string, alias: string) =>
    (await org.admin.post("/api/admin/models", { providerID, upstreamModel: alias, alias, displayName: `${alias} (TEST)`, defaultMaxOutput: 1024, contextLimit: 200000, outputLimit: 8192, price: { input: "1", output: "2" } })).json.id as string
  const responses = await provider("Mock Responses (TEST)", "openai-responses", h.mock.url, ["openai-chat"])
  const gemini = await provider("Mock Gemini (TEST)", "gemini", h.mock.url.replace(/\/v1$/, "/v1beta"))
  const anthropic = await provider("Mock Anthropic (TEST)", "anthropic-messages", h.mock.url)
  const models = [org.modelID, await model(responses, "mock-codex"), await model(gemini, "mock-gemini"), await model(anthropic, "claude-mock")]
  await org.admin.put(`/api/admin/projects/${org.projectID}/models`, { modelIDs: models })
  const tools = ["opencode", "claude-code", "codex", "gemini-cli", "cline", "kilo-code", "qwen-code", "trae", "qoder", "jetbrains-ai", "github-copilot", "cursor"]
  await org.admin.put(`/api/admin/projects/${org.projectID}/tools`, { toolIDs: tools })
  const keys: Record<string, string> = {}
  for (const tool of tools.filter((id) => id !== "opencode"))
    keys[tool] = (await org.members[0]!.client.post("/api/me/tool-keys", { toolID: tool, projectID: org.projectID })).json.key
  // Real path: tools treat a symlinked path (/var → /private/var on macOS) as outside the workspace.
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), "saorsa-lab-")))
  const file = path.join(workspace, "notes.txt")
  await writeFile(file, "Saorsa lab file: the answer is 42.\n")
  return { h, org, keys, workspace, file }
}
