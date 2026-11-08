// Pure statistics over records. No state, no I/O: same records in, same stats out.
// Missing values are `undefined` (rendered as "--"), never 0.
import { addTokens, zeroTokens, type CompactionRecord, type RequestRecord, type SessionRecord, type StatsRecord, type ToolCall, type Tokens } from "./records.ts"

export interface ToolStats {
  calls: number
  failed: number
  totalMs: number
}

export interface GroupStats {
  sessions: number
  /** Completed model requests (steps), including failed ones. */
  requests: number
  failedRequests: number
  /** Requests without streamed text/reasoning: excluded from TTFT and rates. */
  unstreamedRequests: number
  retries: number
  /** Union of busy intervals (requests, tool calls, compactions). */
  activeMs: number
  time: {
    /** Σ TTFT of streamed requests (prefill, incl. server queueing). */
    ttftMs: number
    /** Σ decode time of streamed requests. */
    decodeMs: number
    /** Σ tool execution time (sum, not union). */
    toolMs: number
    /** Σ duration of unstreamed requests, which can't be split into prefill/decode. */
    unsplitMs: number
  }
  /** Σ output / Σ decode time, tokens per second. */
  decodeRate?: number
  /** Σ prefill tokens / Σ TTFT, tokens per second. Excludes retried requests. */
  prefillRate?: number
  avgTtftMs?: number
  /** Σ cacheRead / Σ (input + cacheRead). */
  cacheHitRate?: number
  tools: {
    calls: number
    failed: number
    failureRate?: number
    perRequest?: number
    byName: Record<string, ToolStats>
  }
  /** All tokens: requests + compactions + other usage (title generation). */
  tokens: Tokens
  /** Reasoning was streamed but the provider reported 0 reasoning tokens. */
  reasoningUnreported: boolean
  compactions: number
}

export interface SessionStats {
  sessionID: string
  startedAt: number
  lastActivity: number
  wallMs: number
  /** Main session plus all sub-agents. */
  total: GroupStats
  main: GroupStats
  subAgents: GroupStats
  context: {
    /** Context size of the main session after its last request; unknown right after a compaction. */
    current?: number
    max?: number
    compactions: number
  }
}

type Interval = readonly [number, number]

/** Total length covered by the intervals; overlaps count once. */
export function unionLength(intervals: readonly Interval[]): number {
  const sorted = intervals.filter(([a, b]) => b > a).toSorted((x, y) => x[0] - y[0])
  let total = 0
  let curStart = -Infinity
  let curEnd = -Infinity
  for (const [a, b] of sorted) {
    if (a > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart
      curStart = a
      curEnd = b
    } else if (b > curEnd) curEnd = b
  }
  if (curEnd > curStart) total += curEnd - curStart
  return total
}

const ratio = (num: number, den: number) => (den > 0 ? num / den : undefined)

/** Request eligible for TTFT/prefill averages. */
const ttftEligible = (r: RequestRecord) => !r.failed && r.streamed && r.ttftMs !== undefined && r.retries === 0
/** Request eligible for the decode rate. */
const decodeEligible = (r: RequestRecord) => !r.failed && r.streamed && r.decodeMs !== undefined && r.decodeMs > 0

function groupStats(sessionIDs: ReadonlySet<string>, records: readonly StatsRecord[]): GroupStats {
  const requests: RequestRecord[] = []
  const compactions: CompactionRecord[] = []
  const tools: ToolCall[] = []
  let otherTokens = zeroTokens()

  for (const r of records) {
    if (r.type === "session" || !sessionIDs.has(r.sessionID)) continue
    if (r.type === "request") {
      requests.push(r)
      tools.push(...r.toolCalls)
    } else if (r.type === "tool") tools.push(r)
    else if (r.type === "compaction") compactions.push(r)
    else if (r.type === "usage") otherTokens = addTokens(otherTokens, r.tokens)
  }

  const intervals: Interval[] = []
  const time = { ttftMs: 0, decodeMs: 0, toolMs: 0, unsplitMs: 0 }
  let tokens = otherTokens
  let ttftSum = 0, ttftCount = 0, prefillTokens = 0
  let decodeSum = 0, decodeTokens = 0

  for (const r of requests) {
    tokens = addTokens(tokens, r.tokens)
    intervals.push([r.requestStart ?? r.firstToken ?? r.requestEnd, r.requestEnd])
    if (r.streamed) {
      time.ttftMs += r.ttftMs ?? 0
      time.decodeMs += r.decodeMs ?? 0
    } else if (r.requestStart !== undefined) time.unsplitMs += r.requestEnd - r.requestStart
    if (ttftEligible(r)) {
      ttftSum += r.ttftMs!
      ttftCount++
      prefillTokens += r.tokens.input
    }
    if (decodeEligible(r)) {
      decodeSum += r.decodeMs!
      decodeTokens += r.tokens.output
    }
  }
  for (const c of compactions) {
    if (c.tokens) tokens = addTokens(tokens, c.tokens)
    intervals.push([c.start, c.end])
  }

  const byName: Record<string, ToolStats> = {}
  let failedTools = 0
  for (const t of tools) {
    const ms = Math.max(0, t.endMs - t.startMs)
    time.toolMs += ms
    intervals.push([t.startMs, t.endMs])
    const s = (byName[t.tool] ??= { calls: 0, failed: 0, totalMs: 0 })
    s.calls++
    s.totalMs += ms
    if (!t.ok) {
      s.failed++
      failedTools++
    }
  }

  return {
    sessions: sessionIDs.size,
    requests: requests.length,
    failedRequests: requests.filter((r) => r.failed).length,
    unstreamedRequests: requests.filter((r) => !r.streamed).length,
    retries: requests.reduce((n, r) => n + r.retries, 0),
    activeMs: unionLength(intervals),
    time,
    decodeRate: ratio(decodeTokens, decodeSum / 1000),
    prefillRate: ratio(prefillTokens, ttftSum / 1000),
    avgTtftMs: ratio(ttftSum, ttftCount),
    cacheHitRate: ratio(tokens.cacheRead, tokens.input + tokens.cacheRead),
    tools: {
      calls: tools.length,
      failed: failedTools,
      failureRate: ratio(failedTools, tools.length),
      perRequest: ratio(tools.length, requests.length),
      byName,
    },
    tokens,
    reasoningUnreported: tokens.reasoning === 0 && requests.some((r) => r.hasReasoning),
    compactions: compactions.length,
  }
}

const recordEnd = (r: StatsRecord): number => {
  switch (r.type) {
    case "session": return r.created
    case "request": return r.stepEnd
    case "tool": return r.endMs
    case "compaction": return r.end
    case "usage": return r.ts
  }
}

function sessionMap(records: readonly StatsRecord[]): Map<string, SessionRecord> {
  // Merge repeated session records: a known parent is never lost, and a
  // non-late creation time beats one from a late first sighting.
  const sessions = new Map<string, SessionRecord>()
  for (const r of records) {
    if (r.type !== "session") continue
    const prev = sessions.get(r.sessionID)
    if (!prev) {
      sessions.set(r.sessionID, r)
      continue
    }
    const keepPrevTime = !prev.late && r.late
    sessions.set(r.sessionID, {
      ...r,
      parentSessionID: r.parentSessionID ?? prev.parentSessionID,
      directory: r.directory ?? prev.directory,
      created: keepPrevTime ? prev.created : r.created,
      late: prev.late && r.late,
    })
  }
  return sessions
}

function rootIn(sessions: ReadonlyMap<string, SessionRecord>, id: string): string {
  const seen = new Set<string>()
  let cur = id
  while (!seen.has(cur)) {
    seen.add(cur)
    const parent = sessions.get(cur)?.parentSessionID
    if (!parent) return cur
    cur = parent
  }
  return cur // cycle: stop where we started looping
}

/** The root session of `sessionID` (itself if it has no known parent). */
export function rootSession(records: readonly StatsRecord[], sessionID: string): string {
  return rootIn(sessionMap(records), sessionID)
}

/** Resolves roots and session info for many lookups over the same records. */
export function sessionResolver(records: readonly StatsRecord[]) {
  const sessions = sessionMap(records)
  return {
    root: (sessionID: string) => rootIn(sessions, sessionID),
    get: (sessionID: string) => sessions.get(sessionID),
  }
}

/** Statistics for a root session and all its (nested) sub-agents. */
export function computeStats(records: readonly StatsRecord[], rootSessionID: string, now: number): SessionStats {
  const sessions = sessionMap(records)
  const family = new Set<string>([rootSessionID])
  const subs = new Set<string>()
  for (const id of sessions.keys()) {
    if (id !== rootSessionID && rootIn(sessions, id) === rootSessionID) {
      family.add(id)
      subs.add(id)
    }
  }

  const own = records.filter((r) => family.has(r.sessionID))
  const startedAt = sessions.get(rootSessionID)?.created ?? own.reduce((m, r) => Math.min(m, recordEnd(r)), now)
  const lastActivity = own.reduce((m, r) => Math.max(m, recordEnd(r)), startedAt)

  // Context of the main session: last request, unless a compaction came after it.
  const mainRequests = own.filter((r): r is RequestRecord => r.type === "request" && r.sessionID === rootSessionID && !r.failed)
  const lastRequest = mainRequests.toSorted((a, b) => a.requestEnd - b.requestEnd).at(-1)
  const mainCompactions = own.filter((r): r is CompactionRecord => r.type === "compaction" && r.sessionID === rootSessionID && !r.failed)
  const lastCompaction = mainCompactions.reduce((m, c) => Math.max(m, c.end), -Infinity)
  const current = lastRequest && lastRequest.requestEnd > lastCompaction ? lastRequest.contextTokens : undefined
  const max = mainRequests.length ? mainRequests.reduce((m, r) => Math.max(m, r.contextTokens), 0) : undefined

  const total = groupStats(family, own)
  return {
    sessionID: rootSessionID,
    startedAt,
    lastActivity,
    wallMs: Math.max(0, now - startedAt),
    total,
    main: groupStats(new Set([rootSessionID]), own),
    subAgents: groupStats(subs, own),
    context: { current, max, compactions: total.compactions },
  }
}
