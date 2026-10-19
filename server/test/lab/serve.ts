import { startLab } from "./setup.js"

// Keeps a lab environment running for manual exploration; prints its origin, test keys and workspace as JSON.
// A loopback-only helper approves OpenCode device logins as the seed member (test environment only).
const lab = await startLab()
lab.h.mock.control.toolRounds = { file: lab.file, rounds: Number(process.env.LAB_TOOL_ROUNDS ?? 1) }
const helper = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const code = new URL(request.url).searchParams.get("code")
    const approve = await lab.org.members[0]!.client.post("/api/device/approve", { userCode: code, projectID: lab.org.projectID, acknowledgeNotice: true })
    return new Response(String(approve.status))
  },
})
console.log(JSON.stringify({ origin: lab.h.origin, approve: `http://127.0.0.1:${helper.port}`, keys: lab.keys, workspace: lab.workspace, file: lab.file }))
setInterval(() => {}, 1 << 30)
