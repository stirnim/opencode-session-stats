// Synthetic event sequences for cases the recorded run doesn't cover.
// Times are in seconds relative to BASE (see helpers.ts).
import { describe, expect, test } from "bun:test"
import { Collector } from "../src/collector.ts"
import { computeStats, rootSession, unionLength } from "../src/stats.ts"
import type { RequestRecord } from "../src/records.ts"
import { at, collect, ev, streamedStep, tokens } from "./helpers.ts"

const MAIN = "ses_main"
const SUB1 = "ses_sub1"
const SUB2 = "ses_sub2"
const NOW = at(1000)

const created = (sessionID: string, s: number, parentID?: string) => ev("session.created", s, { sessionID, parentID })

function toolCall(session: string, msg: string, id: string, name: string, start: number, end: number, ok = true) {
  const base = { sessionID: session, assistantMessageID: msg, id }
  return [
    ev("session.tool.input.started", start, { ...base, name }),
    ev("session.tool.called", start, { ...base, executed: false }),
    ok
      ? ev("session.tool.success", end, { ...base, executed: false })
      : ev("session.tool.failed", end, { ...base, error: { message: "boom" }, executed: false }),
  ]
}

describe("unionLength", () => {
  test("empty", () => expect(unionLength([])).toBe(0))
  test("disjoint, unsorted", () => expect(unionLength([[5, 7], [0, 2]])).toBe(4))
  test("nested and overlapping", () => expect(unionLength([[0, 10], [2, 3], [8, 12]])).toBe(12))
  test("touching intervals", () => expect(unionLength([[0, 1], [1, 2]])).toBe(2))
  test("ignores empty and inverted intervals", () => expect(unionLength([[3, 3], [5, 4]])).toBe(0))
})

describe("parallel sub-agents", () => {
  // main request [0,2] spawns two sub-agents via tools running [2,10];
  // sub-agent requests overlap: [3,6] and [4,9].
  const events = [
    created(MAIN, 0),
    ...streamedStep({ session: MAIN, msg: "m1", start: 0, first: 1, end: 2, stepEnd: 10, input: 100, output: 10 }).slice(0, 3),
    ...toolCall(MAIN, "m1", "t1", "subagent", 2, 10),
    ...toolCall(MAIN, "m1", "t2", "subagent", 2, 9),
    created(SUB1, 2, MAIN),
    created(SUB2, 2, MAIN),
    ...streamedStep({ session: SUB1, msg: "s1", start: 3, first: 4, end: 6, input: 50, output: 20 }),
    ...streamedStep({ session: SUB2, msg: "s2", start: 4, first: 5, end: 9, input: 50, output: 40 }),
    ev("session.step.ended", 10, { sessionID: MAIN, assistantMessageID: "m1", finish: "tool-calls", tokens: tokens(100, 10) }),
  ]
  const stats = computeStats(collect(events), MAIN, NOW)

  test("active time counts overlaps once", () => {
    expect(stats.total.activeMs).toBe(10_000)
    expect(stats.subAgents.activeMs).toBe(6_000) // [3,9]
    expect(stats.main.activeMs).toBe(10_000)
  })

  test("tool time is a sum, not a union", () => {
    expect(stats.total.time.toolMs).toBe(8_000 + 7_000)
  })

  test("sub-agent breakdown", () => {
    expect(stats.subAgents.requests).toBe(2)
    expect(stats.subAgents.tokens.output).toBe(60)
    expect(stats.main.tools.calls).toBe(2)
    expect(stats.subAgents.tools.calls).toBe(0)
  })
})

describe("weighted averages", () => {
  // r1: 100 tokens in 1 s (100 tok/s); r2: 1000 tokens in 20 s (50 tok/s).
  const events = [
    created(MAIN, 0),
    ...streamedStep({ session: MAIN, msg: "r1", start: 0, first: 2, end: 3, input: 1000, output: 100 }),
    ...streamedStep({ session: MAIN, msg: "r2", start: 10, first: 18, end: 38, input: 3000, output: 1000 }),
  ]
  const stats = computeStats(collect(events), MAIN, NOW)

  test("decode rate is Σ output / Σ decode, not the mean of rates", () => {
    expect(stats.total.decodeRate).toBeCloseTo(1100 / 21, 9) // not 75
  })
  test("prefill rate is Σ input / Σ TTFT", () => {
    expect(stats.total.prefillRate).toBeCloseTo(4000 / 10, 9) // not mean(500, 375)
  })
  test("avg TTFT", () => expect(stats.total.avgTtftMs).toBe(5000))
})

describe("requests excluded from rates", () => {
  const unstreamed = [
    ev("session.step.started", 7, { sessionID: MAIN, assistantMessageID: "u1", model: { id: "m", providerID: "p" }, started: at(0) }),
    ev("session.tool.input.started", 7, { sessionID: MAIN, assistantMessageID: "u1", id: "t1", name: "read" }),
    ev("session.step.streamed", 7.01, { sessionID: MAIN, assistantMessageID: "u1" }),
    ev("session.tool.called", 7.01, { sessionID: MAIN, assistantMessageID: "u1", id: "t1" }),
    ev("session.tool.success", 7.02, { sessionID: MAIN, assistantMessageID: "u1", id: "t1" }),
    ev("session.step.ended", 7.03, { sessionID: MAIN, assistantMessageID: "u1", tokens: tokens(500, 50) }),
  ]

  test("tool-only step without streaming: counted, but not in TTFT or rates", () => {
    const events = [
      created(MAIN, 0),
      ...unstreamed,
      ...streamedStep({ session: MAIN, msg: "r1", start: 10, first: 11, end: 12, input: 100, output: 50 }),
    ]
    const stats = computeStats(collect(events), MAIN, NOW)
    expect(stats.total.requests).toBe(2)
    expect(stats.total.unstreamedRequests).toBe(1)
    expect(stats.total.avgTtftMs).toBe(1000)
    expect(stats.total.decodeRate).toBe(50)
    expect(stats.total.prefillRate).toBe(100)
    expect(stats.total.time.unsplitMs).toBe(7010)
    expect(stats.total.tokens.input).toBe(600)
  })

  test("tool-only step with streamed tool input counts as streamed", () => {
    const events = [
      created(MAIN, 0),
      ev("session.step.started", 2, { sessionID: MAIN, assistantMessageID: "u1", started: at(0) }),
      ev("session.tool.input.started", 2, { sessionID: MAIN, assistantMessageID: "u1", id: "t1", name: "read" }),
      ev("session.tool.input.delta", 2.1, { sessionID: MAIN, assistantMessageID: "u1", id: "t1", delta: "{" }),
      ev("session.step.streamed", 4, { sessionID: MAIN, assistantMessageID: "u1" }),
      ev("session.step.ended", 4, { sessionID: MAIN, assistantMessageID: "u1", tokens: tokens(200, 100) }),
    ]
    const r = collect(events).find((x): x is RequestRecord => x.type === "request")!
    expect(r.streamed).toBe(true)
    expect(r.ttftMs).toBe(2000)
    expect(r.decodeMs).toBe(2000)
  })

  test("failed step: counted as failed request, tokens kept, no rates", () => {
    const events = [
      created(MAIN, 0),
      ev("session.step.started", 1, { sessionID: MAIN, assistantMessageID: "f1", started: at(0) }),
      ev("session.text.started", 1, { sessionID: MAIN, assistantMessageID: "f1" }),
      ev("session.step.failed", 3, { sessionID: MAIN, assistantMessageID: "f1", error: { message: "x" }, tokens: tokens(100, 20) }),
    ]
    const stats = computeStats(collect(events), MAIN, NOW)
    expect(stats.total.requests).toBe(1)
    expect(stats.total.failedRequests).toBe(1)
    expect(stats.total.tokens.output).toBe(20)
    expect(stats.total.decodeRate).toBeUndefined()
    expect(stats.total.avgTtftMs).toBeUndefined()
    expect(stats.context.current).toBeUndefined()
  })

  test("retried request: excluded from TTFT/prefill (includes backoff), kept for decode", () => {
    const events = [
      created(MAIN, 0),
      ev("session.retry.scheduled", 1, { sessionID: MAIN, assistantMessageID: "r1", attempt: 1, at: at(5) }),
      ...streamedStep({ session: MAIN, msg: "r1", start: 0, first: 8, end: 10, input: 100, output: 200 }),
    ]
    const stats = computeStats(collect(events), MAIN, NOW)
    expect(stats.total.retries).toBe(1)
    expect(stats.total.avgTtftMs).toBeUndefined()
    expect(stats.total.prefillRate).toBeUndefined()
    expect(stats.total.decodeRate).toBe(100)
  })
})

describe("tool failures", () => {
  test("only tool.failed counts as failure", () => {
    const events = [
      created(MAIN, 0),
      ...streamedStep({ session: MAIN, msg: "m1", start: 0, first: 1, end: 2, input: 10, output: 10 }).slice(0, 3),
      ...toolCall(MAIN, "m1", "a", "shell", 2, 3),
      ...toolCall(MAIN, "m1", "b", "edit", 2, 4, false),
      ...toolCall(MAIN, "m1", "c", "edit", 4, 5),
      ev("session.step.ended", 5, { sessionID: MAIN, assistantMessageID: "m1", tokens: tokens(10, 10) }),
    ]
    const stats = computeStats(collect(events), MAIN, NOW)
    expect(stats.total.tools.calls).toBe(3)
    expect(stats.total.tools.failed).toBe(1)
    expect(stats.total.tools.failureRate).toBeCloseTo(1 / 3, 9)
    expect(stats.total.tools.byName.edit).toEqual({ calls: 2, failed: 1, totalMs: 3000 })
  })

  test("tool finishing after its step was recorded is counted once", () => {
    const events = [
      created(MAIN, 0),
      ...streamedStep({ session: MAIN, msg: "m1", start: 0, first: 1, end: 2, input: 10, output: 10 }),
      ...toolCall(MAIN, "m1", "late", "shell", 2, 4),
    ]
    const records = collect(events)
    expect(records.filter((r) => r.type === "tool")).toHaveLength(1)
    expect(computeStats(records, MAIN, NOW).total.tools.calls).toBe(1)
  })
})

describe("robustness", () => {
  test("duplicate step.ended yields one request", () => {
    const steps = streamedStep({ session: MAIN, msg: "m1", start: 0, first: 1, end: 2, input: 10, output: 10 })
    const records = collect([created(MAIN, 0), ...steps, steps[3]!])
    expect(records.filter((r) => r.type === "request")).toHaveLength(1)
  })

  test("events without created/data don't throw", () => {
    expect(() => collect([{ type: "server.connected" } as never, ev("session.status", 1)])).not.toThrow()
  })
})

describe("interruption", () => {
  test("open requests are recorded as interrupted; open tools are dropped", () => {
    const events = [
      created(MAIN, 0),
      ...streamedStep({ session: MAIN, msg: "m1", start: 0, first: 1, end: 2, input: 10, output: 10 }).slice(0, 2),
      ev("session.tool.input.started", 2, { sessionID: MAIN, assistantMessageID: "m1", id: "t", name: "shell" }),
      ev("session.tool.called", 2, { sessionID: MAIN, assistantMessageID: "m1", id: "t" }),
      ev("session.execution.interrupted", 5, { sessionID: MAIN }),
    ]
    const records = collect(events)
    const r = records.find((x): x is RequestRecord => x.type === "request")!
    expect(r.interrupted).toBe(true)
    expect(r.failed).toBe(true)
    expect(r.requestEnd).toBe(at(5))
    expect(r.toolCalls).toHaveLength(0)
    const stats = computeStats(records, MAIN, NOW)
    expect(stats.total.activeMs).toBe(5000)
    expect(stats.total.tools.failed).toBe(0)
  })
})

describe("compaction and context", () => {
  const before = [
    created(MAIN, 0),
    ...streamedStep({ session: MAIN, msg: "m1", start: 0, first: 1, end: 2, input: 5000, output: 500, cacheRead: 1000 }),
    ev("session.compaction.started", 3, { sessionID: MAIN, reason: "auto" }),
    ev("session.compaction.ended", 6, { sessionID: MAIN, reason: "auto", tokens: tokens(6000, 300) }),
  ]

  test("auto compaction: counted, tokens and time included, not a request", () => {
    const stats = computeStats(collect(before), MAIN, NOW)
    expect(stats.context.compactions).toBe(1)
    expect(stats.total.requests).toBe(1)
    expect(stats.total.tokens.input).toBe(11000)
    expect(stats.total.activeMs).toBe(2000 + 3000)
    expect(stats.context.current).toBeUndefined()
    expect(stats.context.max).toBe(6500)
  })

  test("next request restores the current context", () => {
    const events = [...before, ...streamedStep({ session: MAIN, msg: "m2", start: 10, first: 11, end: 12, input: 800, output: 100 })]
    const stats = computeStats(collect(events), MAIN, NOW)
    expect(stats.context.current).toBe(900)
    expect(stats.context.max).toBe(6500)
  })

  test("sub-agent requests don't affect the main context", () => {
    const events = [...before.slice(0, 5), created(SUB1, 1, MAIN), ...streamedStep({ session: SUB1, msg: "s", start: 3, first: 4, end: 5, input: 90000, output: 1 })]
    const stats = computeStats(collect(events), MAIN, NOW)
    expect(stats.context.current).toBe(6500)
    expect(stats.context.max).toBe(6500)
  })
})

describe("session resolution", () => {
  test("rootSession follows the parent chain", () => {
    const records = collect([created(MAIN, 0), created(SUB1, 1, MAIN), created(SUB2, 2, SUB1)])
    expect(rootSession(records, SUB2)).toBe(MAIN)
    expect(rootSession(records, MAIN)).toBe(MAIN)
    expect(rootSession(records, "unknown")).toBe("unknown")
  })

  test("a later session record without parent keeps the known parent", () => {
    const c = new Collector()
    const records = [...collect([created(MAIN, 0), created(SUB1, 1, MAIN)], c), ...c.registerSession({ sessionID: SUB1, created: at(1) })]
    expect(rootSession(records, SUB1)).toBe(MAIN)
  })

  test("a late first sighting doesn't override the real creation time", () => {
    const c = new Collector()
    const records = [
      ...c.registerSession({ sessionID: MAIN, created: at(0) }),
      ...collect([ev("session.status", 50, { sessionID: MAIN })], c),
    ]
    expect(computeStats(records, MAIN, NOW).startedAt).toBe(at(0))
  })
})

describe("nested sub-agents", () => {
  test("a sub-agent of a sub-agent belongs to the family", () => {
    const events = [
      created(MAIN, 0),
      created(SUB1, 1, MAIN),
      created(SUB2, 2, SUB1),
      ...streamedStep({ session: SUB2, msg: "n", start: 3, first: 4, end: 5, input: 10, output: 10 }),
    ]
    const stats = computeStats(collect(events), MAIN, NOW)
    expect(stats.total.sessions).toBe(3)
    expect(stats.subAgents.sessions).toBe(2)
    expect(stats.subAgents.requests).toBe(1)
  })
})

describe("usage outside steps (title generation)", () => {
  test("usage before any step is extra usage", () => {
    const events = [
      created(MAIN, 0),
      ev("session.usage.updated", 1, { sessionID: MAIN, tokens: tokens(400, 10) }),
      ev("session.renamed", 1, { sessionID: MAIN }),
    ]
    const usage = collect(events).filter((r) => r.type === "usage")
    expect(usage.map((u) => [u.tokens.input, u.tokens.output])).toEqual([[400, 10]])
  })

  test("usage.updated right before step.ended is not double counted", () => {
    const steps = streamedStep({ session: MAIN, msg: "m1", start: 0, first: 1, end: 2, input: 100, output: 50 })
    const events = [
      created(MAIN, 0),
      ...steps.slice(0, 3),
      ev("session.usage.updated", 2, { sessionID: MAIN, tokens: tokens(100, 50) }),
      steps[3]!,
    ]
    const records = collect(events)
    expect(records.filter((r) => r.type === "usage")).toHaveLength(0)
    expect(computeStats(records, MAIN, NOW).total.tokens.input).toBe(100)
  })

  test("held-back usage is emitted by flush()", () => {
    const c = new Collector()
    collect([created(MAIN, 0), ev("session.usage.updated", 1, { sessionID: MAIN, tokens: tokens(7, 3) })], c)
    expect(c.flush().map((r) => r.type)).toEqual(["usage"])
    expect(c.flush()).toEqual([])
  })
})

describe("plugin started mid-session", () => {
  const events = [
    // no session.created; cumulative usage already includes unseen steps
    ev("session.usage.updated", 50, { sessionID: MAIN, tokens: tokens(90000, 9000) }),
    ...streamedStep({ session: MAIN, msg: "m9", start: 60, first: 61, end: 62, input: 100, output: 10 }),
    ev("session.usage.updated", 62, { sessionID: MAIN, tokens: tokens(90100, 9010) }),
    ev("session.execution.succeeded", 62, { sessionID: MAIN }),
  ]

  test("first usage.updated is a baseline, not extra usage", () => {
    const records = collect(events)
    expect(records.filter((r) => r.type === "usage")).toHaveLength(0)
    const session = records.find((r) => r.type === "session")!
    expect(session).toMatchObject({ sessionID: MAIN, late: true, created: at(50) })
  })

  test("registerSession overrides start time and parent", () => {
    const c = new Collector()
    const records = [...collect(events, c), ...c.registerSession({ sessionID: MAIN, created: at(0) })]
    const stats = computeStats(records, MAIN, NOW)
    expect(stats.startedAt).toBe(at(0))
    expect(stats.total.requests).toBe(1)
  })

  test("request without step.started: no TTFT, decode still known", () => {
    const records = collect([
      ev("session.text.started", 1, { sessionID: MAIN, assistantMessageID: "x" }),
      ev("session.step.streamed", 3, { sessionID: MAIN, assistantMessageID: "x" }),
      ev("session.step.ended", 3, { sessionID: MAIN, assistantMessageID: "x", tokens: tokens(10, 100) }),
    ])
    const r = records.find((x): x is RequestRecord => x.type === "request")!
    expect(r.requestStart).toBeUndefined()
    expect(r.ttftMs).toBeUndefined()
    expect(r.decodeMs).toBe(2000)
    expect(r.provider).toBe("unknown")
  })
})

describe("missing values", () => {
  test("a session without requests has undefined averages, not 0 or NaN", () => {
    const stats = computeStats(collect([created(MAIN, 0)]), MAIN, at(5))
    expect(stats.wallMs).toBe(5000)
    expect(stats.total.requests).toBe(0)
    expect(stats.total.decodeRate).toBeUndefined()
    expect(stats.total.prefillRate).toBeUndefined()
    expect(stats.total.avgTtftMs).toBeUndefined()
    expect(stats.total.cacheHitRate).toBeUndefined()
    expect(stats.total.tools.failureRate).toBeUndefined()
    expect(stats.total.tools.perRequest).toBeUndefined()
    expect(stats.context.current).toBeUndefined()
    expect(stats.context.max).toBeUndefined()
  })

  test("unknown session id yields empty stats", () => {
    const stats = computeStats([], "nope", at(5))
    expect(stats.total.requests).toBe(0)
    expect(stats.startedAt).toBe(at(5))
  })
})
