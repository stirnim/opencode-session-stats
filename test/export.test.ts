import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildSummary, exportFileName, parseRecords, Recorder, safeName, toLine, writeJsonAtomic } from "../src/export.ts"
import { computeStats, sessionResolver } from "../src/stats.ts"
import { collect, loadEvents } from "./helpers.ts"

const MAIN = "ses_e441cef2effezkTEYTPDNwGO7P"
const SUB = "ses_e441cb9d6ffccUgXFmdU2o90nz"
const records = collect(await loadEvents("run1.events.jsonl"))
const tmp = mkdtempSync(join(tmpdir(), "session-stats-test-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe("JSONL", () => {
  test("stats can be recomputed from the written JSONL", () => {
    const recorder = new Recorder(join(tmp, "data"))
    const resolve = sessionResolver(records)
    const own = records.filter((r) => resolve.root(r.sessionID) === MAIN)
    recorder.append(
      MAIN,
      own.map((r) => toLine(r, { label: "run3", rootSessionID: MAIN, parentSessionID: resolve.get(r.sessionID)?.parentSessionID })),
    )
    const reloaded = recorder.load(MAIN)
    expect(reloaded).toHaveLength(own.length)
    expect(computeStats(reloaded, MAIN, 1)).toEqual(computeStats(records, MAIN, 1))
  })

  test("request lines carry the fields required by the spec", () => {
    const line = readFileSync(join(tmp, "data", `${MAIN}.jsonl`), "utf8")
      .split("\n")
      .map((l) => (l ? JSON.parse(l) : undefined))
      .find((l) => l?.type === "request" && l.sessionID === SUB)
    for (const key of ["ts", "sessionID", "parentSessionID", "isSubAgent", "label", "provider", "model", "requestStart", "firstToken", "requestEnd", "ttftMs", "decodeMs", "tokens", "toolCalls", "contextTokens"])
      expect(line).toHaveProperty(key)
    expect(line.isSubAgent).toBe(true)
    expect(line.decodeMs).toBeNull() // unstreamed: present, but null
    expect(line.parentSessionID).toBe(MAIN)
    expect(Object.keys(line.tokens).toSorted()).toEqual(["cacheRead", "cacheWrite", "input", "output", "reasoning"])
  })

  test("broken and unknown lines are skipped", () => {
    const parsed = parseRecords('{"type":"usage","ts":1,"sessionID":"s","tokens":{}}\n{"type":"meta"}\n{"type":"requ')
    expect(parsed.map((r) => r.type)).toEqual(["usage"])
  })

  test("loading a missing file gives no records", () => {
    expect(new Recorder(join(tmp, "empty")).load("nope")).toEqual([])
  })
})

describe("summary", () => {
  const summary = buildSummary(records, MAIN, 1794153800000, {
    label: "run3",
    opencodeVersion: "2.2.6",
    pluginVersion: "0.1.0",
    directory: "/fallback",
  })

  test("contains metadata and stats", () => {
    expect(summary).toMatchObject({
      summaryVersion: 1,
      sessionID: MAIN,
      label: "run3",
      directory: "/fallback", // fixture has no directory in its session records
      opencodeVersion: "2.2.6",
      startedAt: new Date(1794153582831).toISOString(),
      lastActivity: new Date(1794153684243).toISOString(),
    })
    expect(summary.stats.total.requests).toBe(7)
  })

  test("atomic write leaves no temp file and replaces the old content", () => {
    const path = join(tmp, "atomic", "s.json")
    writeJsonAtomic(path, { a: 1 })
    writeJsonAtomic(path, summary)
    expect(JSON.parse(readFileSync(path, "utf8")).sessionID).toBe(MAIN)
    expect(readdirSync(join(tmp, "atomic"))).toEqual(["s.json"])
  })

  test("recorder writes the summary next to the JSONL", () => {
    const recorder = new Recorder(join(tmp, "data"))
    recorder.writeSummary(summary)
    expect(existsSync(join(tmp, "data", `${MAIN}.json`))).toBe(true)
  })
})

describe("names", () => {
  test("labels become safe file names", () => {
    expect(safeName("sqli codex/run 3")).toBe("sqli-codex-run-3")
    expect(exportFileName(MAIN, "sqli-codex-run3")).toBe("session-stats-sqli-codex-run3.json")
    expect(exportFileName(MAIN)).toBe(`session-stats-${MAIN}.json`)
    expect(exportFileName(MAIN, "///")).toBe(`session-stats-${MAIN}.json`)
  })
})
