// Turns raw OpenCode v2 events into completed records. Stateful, but has no
// I/O and no UI. README.md ("How it measures") lists which event marks which moment.
import { addTokens, zeroTokens, type StatsRecord, type ToolCall, type Tokens } from "./records.ts"

/** The subset of an OpenCode event the collector reads. */
export interface RawEvent {
  type: string
  created: number
  data?: any
}

interface ApiTokens {
  input?: number
  output?: number
  reasoning?: number
  cache?: { read?: number; write?: number }
}

interface PendingRequest {
  sessionID: string
  messageID: string
  provider?: string
  model?: string
  variant?: string
  agent?: string
  requestStart?: number
  firstToken?: number
  streamEnd?: number
  streamed: boolean
  hasReasoning: boolean
  retries: number
  toolCalls: ToolCall[]
}

interface PendingTool {
  sessionID: string
  messageID: string
  callID: string
  tool?: string
  startMs?: number
}

interface SessionState {
  usagePrev?: Tokens
  /** Step/compaction tokens recorded since the last session.usage.updated. */
  usagePending: Tokens
  /**
   * Usage growth not explained by recorded steps/compactions, held back for
   * one event: usage.updated can arrive just before the compaction.ended
   * (or step.ended) that explains it.
   */
  unexplained?: { ts: number; tokens: Tokens }
}

const ENDS_WITH_TOKENS = new Set(["session.step.ended", "session.step.failed", "session.compaction.ended", "session.compaction.failed"])

export function normalizeTokens(t: ApiTokens | undefined): Tokens {
  return {
    input: t?.input ?? 0,
    output: t?.output ?? 0,
    reasoning: t?.reasoning ?? 0,
    cacheRead: t?.cache?.read ?? 0,
    cacheWrite: t?.cache?.write ?? 0,
  }
}

const subtractClamped = (a: Tokens, b: Tokens, c: Tokens): Tokens => ({
  input: Math.max(0, a.input - b.input - c.input),
  output: Math.max(0, a.output - b.output - c.output),
  reasoning: Math.max(0, a.reasoning - b.reasoning - c.reasoning),
  cacheRead: Math.max(0, a.cacheRead - b.cacheRead - c.cacheRead),
  cacheWrite: Math.max(0, a.cacheWrite - b.cacheWrite - c.cacheWrite),
})

const minTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: Math.min(a.input, b.input),
  output: Math.min(a.output, b.output),
  reasoning: Math.min(a.reasoning, b.reasoning),
  cacheRead: Math.min(a.cacheRead, b.cacheRead),
  cacheWrite: Math.min(a.cacheWrite, b.cacheWrite),
})

const isZero = (t: Tokens) => t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite === 0

export class Collector {
  private sessions = new Map<string, SessionState>()
  private requests = new Map<string, PendingRequest>()
  /** Message IDs already recorded; late events for them must not reopen a request. */
  private completed = new Set<string>()
  private tools = new Map<string, PendingTool>()
  private compactions = new Map<string, { start: number; reason: string }>()

  /** Feeds one event; returns the records it completed (often none). */
  apply(event: RawEvent): StatsRecord[] {
    const d = event.data ?? {}
    const t = event.created
    const out: StatsRecord[] = []
    if (typeof d.sessionID === "string" && event.type !== "session.created") this.touchSession(d.sessionID, t, out)
    // Tokens of this event already contained in the last usage.updated.
    let alreadyCounted = zeroTokens()
    const held = typeof d.sessionID === "string" ? this.sessions.get(d.sessionID)?.unexplained : undefined
    if (held) {
      let rest = held.tokens
      if (ENDS_WITH_TOKENS.has(event.type) && d.tokens) {
        const own = normalizeTokens(d.tokens)
        alreadyCounted = minTokens(own, rest)
        rest = subtractClamped(rest, own, zeroTokens())
      }
      this.sessions.get(d.sessionID)!.unexplained = undefined
      if (!isZero(rest)) out.push({ type: "usage", ts: held.ts, sessionID: d.sessionID, tokens: rest })
    }

    switch (event.type) {
      case "session.created": {
        // We see the whole session, so its usage starts at zero (no baseline needed).
        this.session(d.sessionID).usagePrev ??= zeroTokens()
        out.push({
          type: "session",
          ts: t,
          sessionID: d.sessionID,
          parentSessionID: d.parentID,
          created: t,
          late: false,
          directory: d.location?.directory,
        })
        break
      }
      case "session.step.started": {
        const r = this.request(d.sessionID, d.assistantMessageID)
        r.requestStart = d.started ?? t
        r.provider = d.model?.providerID
        r.model = d.model?.id
        r.variant = d.model?.variant
        r.agent = d.agent
        break
      }
      case "session.text.started":
        this.markFirstToken(d.sessionID, d.assistantMessageID, t, true)
        break
      case "session.reasoning.started":
        this.markFirstToken(d.sessionID, d.assistantMessageID, t, true)
        this.request(d.sessionID, d.assistantMessageID).hasReasoning = true
        break
      case "session.tool.input.started": {
        this.markFirstToken(d.sessionID, d.assistantMessageID, t, false)
        this.tool(d.sessionID, d.assistantMessageID, d.id).tool = d.name
        break
      }
      case "session.tool.input.delta":
        // Only providers that stream tool arguments emit these; then the
        // tool-input start is a real first token.
        this.request(d.sessionID, d.assistantMessageID).streamed = true
        break
      case "session.step.streamed":
        this.request(d.sessionID, d.assistantMessageID).streamEnd = t
        break
      case "session.retry.scheduled":
        this.request(d.sessionID, d.assistantMessageID).retries++
        break
      case "session.tool.called":
        this.tool(d.sessionID, d.assistantMessageID, d.id).startMs = t
        break
      case "session.tool.success":
      case "session.tool.failed":
        this.finishTool(d.sessionID, d.assistantMessageID, d.id, t, event.type === "session.tool.success", out)
        break
      case "session.step.ended":
      case "session.step.failed": {
        if (this.completed.has(d.assistantMessageID)) break // duplicate end
        const failed = event.type === "session.step.failed"
        const tokens = normalizeTokens(d.tokens)
        this.addPendingUsage(d.sessionID, subtractClamped(tokens, alreadyCounted, zeroTokens()))
        out.push(this.finishRequest(d.assistantMessageID, d.sessionID, t, tokens, d.finish, failed, false))
        break
      }
      case "session.execution.interrupted":
      case "session.execution.failed":
        // Requests still open in this session will never end; keep what we know.
        for (const r of [...this.requests.values()]) {
          if (r.sessionID === d.sessionID)
            out.push(this.finishRequest(r.messageID, r.sessionID, t, zeroTokens(), undefined, true, event.type === "session.execution.interrupted"))
        }
        break
      case "session.compaction.started":
        this.compactions.set(d.sessionID, { start: t, reason: d.reason })
        break
      case "session.compaction.ended":
      case "session.compaction.failed": {
        const c = this.compactions.get(d.sessionID)
        this.compactions.delete(d.sessionID)
        const tokens = d.tokens ? normalizeTokens(d.tokens) : undefined
        if (tokens) this.addPendingUsage(d.sessionID, subtractClamped(tokens, alreadyCounted, zeroTokens()))
        out.push({
          type: "compaction",
          ts: t,
          sessionID: d.sessionID,
          reason: d.reason ?? c?.reason ?? "unknown",
          start: c?.start ?? t,
          end: t,
          tokens,
          failed: event.type === "session.compaction.failed",
        })
        break
      }
      case "session.usage.updated": {
        // Cumulative per-session usage. Whatever grew beyond the steps and
        // compactions we recorded was spent elsewhere (title generation).
        const s = this.session(d.sessionID)
        const total = normalizeTokens(d.tokens)
        if (s.usagePrev) {
          const extra = subtractClamped(total, s.usagePrev, s.usagePending)
          if (!isZero(extra)) s.unexplained = { ts: t, tokens: extra }
        }
        s.usagePrev = total
        s.usagePending = zeroTokens()
        break
      }
    }
    return out
  }

  /** Emits usage still held back (e.g. before writing a final summary). */
  flush(): StatsRecord[] {
    const out: StatsRecord[] = []
    for (const [sessionID, s] of this.sessions) {
      if (s.unexplained) out.push({ type: "usage", ts: s.unexplained.ts, sessionID, tokens: s.unexplained.tokens })
      s.unexplained = undefined
    }
    return out
  }

  /**
   * Adds session info from the data API (e.g. for sessions created before the
   * plugin started). Emits an updated session record.
   */
  registerSession(info: { sessionID: string; parentSessionID?: string; created: number; directory?: string }): StatsRecord[] {
    this.session(info.sessionID)
    return [{ type: "session", ts: info.created, late: false, ...info }]
  }

  private session(id: string): SessionState {
    let s = this.sessions.get(id)
    if (!s) this.sessions.set(id, (s = { usagePending: zeroTokens() }))
    return s
  }

  private touchSession(id: string, t: number, out: StatsRecord[]) {
    if (this.sessions.has(id)) return
    this.session(id)
    // First event of a session whose session.created we never saw: we started late.
    out.push({ type: "session", ts: t, sessionID: id, created: t, late: true })
  }

  private request(sessionID: string, messageID: string): PendingRequest {
    let r = this.requests.get(messageID)
    if (!r) {
      r = { sessionID, messageID, streamed: false, hasReasoning: false, retries: 0, toolCalls: [] }
      // A detached object for late events of a recorded request: updates are discarded.
      if (!this.completed.has(messageID)) this.requests.set(messageID, r)
    }
    return r
  }

  private markFirstToken(sessionID: string, messageID: string, t: number, streamed: boolean) {
    const r = this.request(sessionID, messageID)
    if (r.firstToken === undefined || t < r.firstToken) r.firstToken = t
    if (streamed) r.streamed = true
  }

  private tool(sessionID: string, messageID: string, callID: string): PendingTool {
    const key = `${sessionID}/${callID}`
    let p = this.tools.get(key)
    if (!p) this.tools.set(key, (p = { sessionID, messageID, callID }))
    return p
  }

  private finishTool(sessionID: string, messageID: string, callID: string, t: number, ok: boolean, out: StatsRecord[]) {
    const p = this.tool(sessionID, messageID, callID)
    this.tools.delete(`${sessionID}/${callID}`)
    const call: ToolCall = { callID, tool: p.tool ?? "unknown", startMs: p.startMs ?? t, endMs: t, ok }
    const r = this.requests.get(messageID)
    if (r) r.toolCalls.push(call)
    else out.push({ type: "tool", ts: t, sessionID, messageID, ...call })
  }

  private addPendingUsage(sessionID: string, tokens: Tokens) {
    const s = this.session(sessionID)
    s.usagePending = addTokens(s.usagePending, tokens)
  }

  private finishRequest(
    messageID: string,
    sessionID: string,
    t: number,
    tokens: Tokens,
    finish: string | undefined,
    failed: boolean,
    interrupted: boolean,
  ): StatsRecord {
    const r = this.request(sessionID, messageID)
    this.requests.delete(messageID)
    this.completed.add(messageID)
    const requestEnd = r.streamEnd ?? t
    const hasTiming = r.streamed && r.firstToken !== undefined
    return {
      type: "request",
      ts: t,
      sessionID,
      messageID,
      provider: r.provider ?? "unknown",
      model: r.model ?? "unknown",
      variant: r.variant,
      agent: r.agent,
      requestStart: r.requestStart,
      firstToken: r.firstToken,
      requestEnd,
      stepEnd: t,
      streamed: r.streamed,
      hasReasoning: r.hasReasoning,
      ttftMs: hasTiming && r.requestStart !== undefined ? r.firstToken! - r.requestStart : undefined,
      decodeMs: hasTiming ? requestEnd - r.firstToken! : undefined,
      tokens,
      finish,
      failed,
      interrupted,
      retries: r.retries,
      toolCalls: r.toolCalls,
      contextTokens: tokens.input + tokens.cacheRead + tokens.output,
    }
  }
}
