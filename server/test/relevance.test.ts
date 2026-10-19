import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chat, eventually, seedOrg, startHarness, type Harness } from "./harness.js"

// Project-relevance hints: keyword heuristic and the opt-in audit classifier. Both may only ever create
// "info" review prompts with explainable evidence, never block, and never send unredacted secrets.

let h: Harness
let org: Awaited<ReturnType<typeof seedOrg>>
const verdict = (value: { related: boolean; confidence: number; reasons: string[] }) => JSON.stringify(value)
const relevanceEvents = () =>
  h.sql`select severity, detector, confidence::float as confidence, evidence, summary_redacted from risk_events
    where category = 'project_relevance' order by created_at`
const prompt = (session: string, content: string, extra: Array<Record<string, unknown>> = []) =>
  chat(h.origin, org.members[0]!.token, { model: "mock-chat", messages: [...extra, { role: "user", content }] }, { "x-opencode-session-id": session }).then(
    (response) => response.text().then(() => response.status),
  )
const offTopic = "Plan my wedding seating chart and write romantic poems for every guest at the reception dinner party tonight"

beforeAll(async () => {
  h = await startHarness()
  org = await seedOrg(h)
})

afterAll(async () => {
  await h.stop()
})

beforeEach(async () => {
  await h.sql`delete from notifications`
  await h.sql`delete from risk_events where category = 'project_relevance'`
  h.mock.control.replyText = undefined
  h.mock.control.bodies.length = 0
})

describe("audit classifier configuration", () => {
  test("requires explicit consent and a managed OpenAI-compatible model", async () => {
    const consent = await org.admin.patch("/api/admin/policies/project_relevance", { enabled: true, config: { mode: "audit_model", model_alias: "mock-chat" } })
    expect(consent.status).toBe(422)
    expect(consent.json.error.code).toBe("audit_model_consent")
    const unknown = await org.admin.patch("/api/admin/policies/project_relevance", {
      enabled: true,
      config: { mode: "audit_model", model_alias: "http://169.254.169.254/latest", allow_audit_model: true },
    })
    expect(unknown.status).toBe(422)
    expect(unknown.json.error.code).toBe("audit_model_unknown")
    const ok = await org.admin.patch("/api/admin/policies/project_relevance", {
      enabled: true,
      config: { mode: "audit_model", model_alias: "mock-chat", allow_audit_model: true },
    })
    expect(ok.status).toBe(200)
  })

  test("the classifier only ever creates a review prompt and never blocks", async () => {
    const block = await org.admin.patch("/api/admin/policies/project_relevance", { action: "block" })
    expect(block.status).toBe(422)
  })
})

describe("audit classifier verdicts", () => {
  test("a confident 'unrelated' verdict creates one explainable info event per session, from redacted input", async () => {
    h.mock.control.replyText = verdict({ related: false, confidence: 0.92, reasons: ["Request is about wedding planning", "No overlap with image preprocessing"] })
    const secret = "AKIAQWERTYUIOPASDFGH"
    expect(await prompt("ses_rel_1", `${offTopic}. Also my key is ${secret}`)).toBe(200)
    const events = await eventually(relevanceEvents, (rows) => rows.length > 0)
    expect(events.length).toBe(1)
    expect(events[0].severity).toBe("info")
    expect(events[0].detector).toBe("classifier:audit_model")
    expect(events[0].confidence).toBeCloseTo(0.92)
    expect(events[0].evidence.reasons).toContain("Request is about wedding planning")
    expect(events[0].evidence.explanation).toContain("not proof")
    // What left for the classifier was redacted.
    const classifierCall = h.mock.control.bodies.find((body) => JSON.stringify(body).includes("plausibly relates"))
    expect(classifierCall).toBeDefined()
    expect(JSON.stringify(classifierCall)).not.toContain(secret)
    expect(JSON.stringify(classifierCall)).toContain("REDACTED")
    // Same OpenCode session again: still one event.
    expect(await prompt("ses_rel_1", `${offTopic} and the dessert menu`)).toBe(200)
    await Bun.sleep(300)
    expect((await relevanceEvents()).length).toBe(1)
    // The member is notified that it is a review prompt, not a finding.
    const [note] = await h.sql`select body from notifications where user_id = ${org.members[0]!.id} and category = 'risk'`
    expect(note.body).toContain("not a finding of misconduct")
  })

  test("related or low-confidence verdicts create nothing", async () => {
    h.mock.control.replyText = verdict({ related: true, confidence: 0.99, reasons: ["About image preprocessing"] })
    expect(await prompt("ses_rel_2", "Optimize the image preprocessing pipeline resize and normalization steps for the training data loader")).toBe(200)
    h.mock.control.replyText = verdict({ related: false, confidence: 0.5, reasons: ["Unclear"] })
    expect(await prompt("ses_rel_3", offTopic)).toBe(200)
    await Bun.sleep(400)
    expect((await relevanceEvents()).length).toBe(0)
  })

  test("malformed classifier output is ignored instead of guessed", async () => {
    h.mock.control.replyText = "I think this is probably unrelated but I am not sure."
    expect(await prompt("ses_rel_4", offTopic)).toBe(200)
    await Bun.sleep(400)
    expect((await relevanceEvents()).length).toBe(0)
  })

  test("tool-result turns are never judged as prompts", async () => {
    h.mock.control.replyText = verdict({ related: false, confidence: 0.95, reasons: ["unrelated"] })
    const response = await chat(
      h.origin,
      org.members[0]!.token,
      {
        model: "mock-chat",
        messages: [
          { role: "user", content: "short" },
          { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }] },
          { role: "tool", tool_call_id: "c1", content: offTopic },
        ],
      },
      { "x-opencode-session-id": "ses_rel_5" },
    )
    await response.text()
    await Bun.sleep(400)
    expect((await relevanceEvents()).length).toBe(0)
  })
})

describe("keyword heuristic", () => {
  test("on-topic prompts pass and off-topic prompts create a weak info hint with matched keywords", async () => {
    await org.admin.patch("/api/admin/policies/project_relevance", { enabled: true, config: { mode: "keyword", min_overlap: 0.05 } })
    expect(await prompt("ses_kw_1", "Improve the image preprocessing pipeline so normalization and resizing run before training batches")).toBe(200)
    await Bun.sleep(300)
    expect((await relevanceEvents()).length).toBe(0)
    expect(await prompt("ses_kw_2", offTopic)).toBe(200)
    const events = await eventually(relevanceEvents, (rows) => rows.length > 0)
    expect(events[0].detector).toBe("heuristic:keyword_overlap")
    expect(events[0].confidence).toBeLessThan(0.5)
    expect(events[0].evidence.project_keywords).toContain("preprocessing")
    await org.admin.patch("/api/admin/policies/project_relevance", { enabled: false })
  })
})
