// Recorded run with OpenCode 2.2.6: main session with two parallel
// sub-agents, 4 parallel tool calls, two prompts and a manual compaction,
// followed by a second, unrelated root session. Expected values were computed
// by hand from the event timestamps.
import { describe, expect, test } from "bun:test"
import { computeStats } from "../src/stats.ts"
import type { RequestRecord } from "../src/records.ts"
import { collect, loadEvents } from "./helpers.ts"

const MAIN = "ses_e441cef2effezkTEYTPDNwGO7P"
const SUB_A = "ses_e441cb9d6ffccUgXFmdU2o90nz"
const SUB_B = "ses_e441cb9d5ffeGei1b7exFMsZA4"
const OTHER = "ses_e43fe042bffeqYZkji29DrPZNt"
const T0 = 1794153580000 // timestamps below are T0 + ms
const NOW = T0 + 200_000

const records = collect(await loadEvents("run1.events.jsonl"))
const stats = computeStats(records, MAIN, NOW)
const request = (suffix: string) =>
  records.find((r): r is RequestRecord => r.type === "request" && r.messageID.endsWith(suffix))!

describe("recorded run: request records", () => {
  test("streamed request with reasoning first", () => {
    const r = request("TRBrNF")
    expect(r.requestStart).toBe(T0 + 2841)
    expect(r.firstToken).toBe(T0 + 9690) // reasoning.started, not the first delta
    expect(r.requestEnd).toBe(T0 + 16459) // step.streamed
    expect(r.stepEnd).toBe(T0 + 30570) // step.ended waits for the sub-agents
    expect(r.ttftMs).toBe(6849)
    expect(r.decodeMs).toBe(6769)
    expect(r.streamed).toBe(true)
    expect(r.provider).toBe("m5")
    expect(r.model).toBe("deepseek-v4.1-flash")
    expect(r.variant).toBe("high")
    expect(r.toolCalls.map((t) => [t.tool, t.endMs - t.startMs])).toEqual([
      ["shell", 23],
      ["shell", 25],
      ["subagent", 12215],
      ["subagent", 14116],
    ])
  })

  test("tool-only step without streaming has no TTFT/decode", () => {
    const r = request("mPGsY4")
    expect(r.streamed).toBe(false)
    expect(r.ttftMs).toBeUndefined()
    expect(r.decodeMs).toBeUndefined()
    expect(r.firstToken).toBe(T0 + 22937) // tool.input.started, still recorded
  })

  test("context tokens = input + cacheRead + output", () => {
    expect(request("5HivX2").contextTokens).toBe(695 + 9130 + 552)
  })

  test("title generation shows up as extra usage", () => {
    const usage = records.filter((r) => r.type === "usage")
    expect(usage.map((u) => [u.sessionID, u.tokens.input, u.tokens.output])).toEqual([
      [MAIN, 523, 351],
      [OTHER, 467, 3],
    ])
  })
})

describe("recorded run: session stats", () => {
  test("family and grouping", () => {
    expect(stats.total.sessions).toBe(3)
    expect(stats.main.sessions).toBe(1)
    expect(stats.subAgents.sessions).toBe(2)
    expect(stats.total.requests).toBe(7)
    expect(stats.main.requests).toBe(3)
    expect(stats.subAgents.requests).toBe(4)
    expect(stats.total.unstreamedRequests).toBe(2)
  })

  test("weighted averages over streamed requests", () => {
    // main: TTFT 6849 + 674 + 596, decode 6769 + 4576 + 7317, output 468 + 670 + 552
    expect(stats.main.avgTtftMs).toBeCloseTo(8119 / 3, 6)
    expect(stats.main.decodeRate).toBeCloseTo(1690 / 18.662, 6)
    expect(stats.main.prefillRate).toBeCloseTo(9827 / 8.119, 6)
    // sub-agents: only the two streamed requests count
    expect(stats.subAgents.avgTtftMs).toBeCloseTo(4836 / 2, 6)
    expect(stats.subAgents.decodeRate).toBeCloseTo(281 / 4.054, 6)
    expect(stats.subAgents.prefillRate).toBeCloseTo(3013 / 4.836, 6)
    // total
    expect(stats.total.avgTtftMs).toBeCloseTo(12955 / 5, 6)
    expect(stats.total.decodeRate).toBeCloseTo(1971 / 22.716, 6)
    expect(stats.total.prefillRate).toBeCloseTo(12840 / 12.955, 6)
  })

  test("time split", () => {
    expect(stats.total.time).toEqual({ ttftMs: 12955, decodeMs: 22716, toolMs: 26391, unsplitMs: 6471 + 10885 })
  })

  test("token totals match OpenCode's own cumulative usage", () => {
    // Σ session.usage.updated of all three sessions: steps + compaction + title.
    expect(stats.total.tokens).toEqual({ input: 28541, output: 3072, reasoning: 0, cacheRead: 40988, cacheWrite: 0 })
    expect(stats.total.cacheHitRate).toBeCloseTo(40988 / (28541 + 40988), 9)
  })

  test("tool calls", () => {
    expect(stats.total.tools.calls).toBe(6)
    expect(stats.total.tools.failed).toBe(0) // shell exit 1 is not a failure
    expect(stats.total.tools.failureRate).toBe(0)
    expect(stats.total.tools.perRequest).toBeCloseTo(6 / 7, 9)
    expect(stats.total.tools.byName).toEqual({
      shell: { calls: 2, failed: 0, totalMs: 48 },
      subagent: { calls: 2, failed: 0, totalMs: 26331 },
      read: { calls: 2, failed: 0, totalMs: 12 },
    })
    expect(stats.subAgents.tools.calls).toBe(2)
  })

  test("active time is the union of busy intervals", () => {
    // [2841, 30568] + [30577, 35827] + [82572, 90485] + compaction [97201, 104243]
    expect(stats.total.activeMs).toBe(27727 + 5250 + 7913 + 7042)
    // parallel sub-agents: [16472, 30559], counted once
    expect(stats.subAgents.activeMs).toBe(14087)
  })

  test("wall clock, context and compactions", () => {
    expect(stats.startedAt).toBe(T0 + 2831)
    expect(stats.wallMs).toBe(NOW - (T0 + 2831))
    expect(stats.lastActivity).toBe(T0 + 104243)
    expect(stats.context.current).toBeUndefined() // compaction after the last request
    expect(stats.context.max).toBe(695 + 9130 + 552)
    expect(stats.context.compactions).toBe(1)
  })

  test("second root session is kept separate", () => {
    const other = computeStats(records, OTHER, NOW)
    expect(other.total.sessions).toBe(1)
    expect(other.total.requests).toBe(3)
    expect(other.total.unstreamedRequests).toBe(1)
    expect(other.context.current).toBe(134 + 7958 + 111)
    expect(other.total.tokens.input).toBe(8561) // its final cumulative usage
  })

  test("sub-agent ids are linked to the main session", () => {
    const sessions = records.filter((r) => r.type === "session")
    expect(sessions.filter((s) => s.parentSessionID === MAIN).map((s) => s.sessionID).toSorted()).toEqual([SUB_B, SUB_A].toSorted())
  })
})
