// File output: raw records as JSONL (append-only, one file per root session)
// and a summary JSON (rewritten atomically on every change).
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { StatsRecord } from "./records.ts"
import { computeStats, sessionResolver, type SessionStats } from "./stats.ts"

export const SUMMARY_VERSION = 1

export interface SummaryMeta {
  label?: string
  opencodeVersion: string
  pluginVersion: string
  /** Fallback when the session record carries no directory. */
  directory?: string
}

export interface Summary {
  summaryVersion: number
  sessionID: string
  label?: string
  directory?: string
  opencodeVersion: string
  pluginVersion: string
  startedAt: string
  lastActivity: string
  updatedAt: string
  stats: SessionStats
}

const iso = (ms: number) => new Date(ms).toISOString()

export function buildSummary(records: readonly StatsRecord[], rootSessionID: string, now: number, meta: SummaryMeta): Summary {
  const stats = computeStats(records, rootSessionID, now)
  return {
    summaryVersion: SUMMARY_VERSION,
    sessionID: rootSessionID,
    label: meta.label,
    directory: sessionResolver(records).get(rootSessionID)?.directory ?? meta.directory,
    opencodeVersion: meta.opencodeVersion,
    pluginVersion: meta.pluginVersion,
    startedAt: iso(stats.startedAt),
    lastActivity: iso(stats.lastActivity),
    updatedAt: iso(now),
    stats,
  }
}

/** Writes via a temp file and rename, so readers never see a partial file. */
export function writeJsonAtomic(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n")
  renameSync(tmp, path)
}

/**
 * One JSONL line per record. Besides the record itself, lines carry the
 * benchmark label and the sub-agent relation, so files are self-describing.
 */
export function toLine(record: StatsRecord, extra: { label?: string; rootSessionID: string; parentSessionID?: string }) {
  const line: Record<string, unknown> = { ...record }
  if (extra.label) line.label = extra.label
  if (record.type === "request") {
    line.parentSessionID = extra.parentSessionID
    line.isSubAgent = record.sessionID !== extra.rootSessionID
    // Keep every field present: missing values are written as null.
    for (const key of REQUEST_OPTIONAL) line[key] ??= null
  }
  return line
}

const REQUEST_OPTIONAL = ["parentSessionID", "requestStart", "firstToken", "ttftMs", "decodeMs", "variant", "agent", "finish"] as const

const RECORD_TYPES = new Set<string>(["session", "request", "tool", "compaction", "usage"])

/** null in JSON means "missing"; records use undefined for that. */
function nullsToUndefined(value: Record<string, unknown>) {
  for (const key of Object.keys(value)) if (value[key] === null) delete value[key]
  return value
}

/** Parses JSONL back into records; unknown line types and broken lines are skipped. */
export function parseRecords(text: string): StatsRecord[] {
  const out: StatsRecord[] = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line)
      if (value && RECORD_TYPES.has(value.type)) out.push(nullsToUndefined(value) as unknown as StatsRecord)
    } catch {
      // A line cut off by a crash; keep the rest.
    }
  }
  return out
}

/** File-name-safe version of a label. */
export function safeName(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100)
}

export function exportFileName(rootSessionID: string, label?: string): string {
  const name = label ? safeName(label) : ""
  return `session-stats-${name || rootSessionID}.json`
}

export function expandHome(path: string): string {
  return path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path
}

/** Continuous recording into the data directory. */
export class Recorder {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  jsonlPath(rootSessionID: string) {
    return join(this.dir, `${rootSessionID}.jsonl`)
  }

  summaryPath(rootSessionID: string) {
    return join(this.dir, `${rootSessionID}.json`)
  }

  append(rootSessionID: string, lines: readonly object[]) {
    if (lines.length === 0) return
    appendFileSync(this.jsonlPath(rootSessionID), lines.map((l) => JSON.stringify(l) + "\n").join(""))
  }

  /** Records recorded earlier for this root session (e.g. before a TUI restart). */
  load(rootSessionID: string): StatsRecord[] {
    const path = this.jsonlPath(rootSessionID)
    return existsSync(path) ? parseRecords(readFileSync(path, "utf8")) : []
  }

  writeSummary(summary: Summary) {
    writeJsonAtomic(this.summaryPath(summary.sessionID), summary)
  }
}
