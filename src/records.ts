// Records are the unit of persistence: the collector turns raw events into
// records, the JSONL export stores them, and statistics are computed from
// records only. That way every statistic can be recomputed from the JSONL.

export interface Tokens {
  input: number // uncached prompt tokens (OpenCode v2 excludes cache reads)
  output: number // includes reasoning when the provider doesn't split it out
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface ToolCall {
  callID: string
  tool: string
  startMs: number
  endMs: number
  ok: boolean
}

export interface SessionRecord {
  type: "session"
  ts: number
  sessionID: string
  parentSessionID?: string
  /** Session creation time; the first time we saw the session if `late` is true. */
  created: number
  /** True when session.created was not observed (plugin started mid-session). */
  late: boolean
  /** Project directory the session runs in. */
  directory?: string
}

export interface RequestRecord {
  type: "request"
  ts: number
  sessionID: string
  messageID: string
  provider: string
  model: string
  variant?: string
  agent?: string
  /** Request sent (step.started data.started). Missing if the plugin started mid-request. */
  requestStart?: number
  /** First text/reasoning/tool-input output. */
  firstToken?: number
  /** Model stream finished (step.streamed). Decode end. */
  requestEnd: number
  /** Step completed, after its tool calls finished (step.ended / step.failed). */
  stepEnd: number
  /** Output was streamed (text, reasoning or tool-input deltas), so TTFT/decode are meaningful. */
  streamed: boolean
  /** Reasoning was streamed; with tokens.reasoning = 0 the provider doesn't report it. */
  hasReasoning: boolean
  ttftMs?: number
  decodeMs?: number
  tokens: Tokens
  finish?: string
  failed: boolean
  interrupted: boolean
  retries: number
  toolCalls: ToolCall[]
  /** Context size after this request: input + cacheRead + output. */
  contextTokens: number
}

/** Tool call whose request was no longer pending when it finished (rare). */
export interface ToolRecord extends ToolCall {
  type: "tool"
  ts: number
  sessionID: string
  messageID: string
}

export interface CompactionRecord {
  type: "compaction"
  ts: number
  sessionID: string
  reason: string
  start: number
  end: number
  tokens?: Tokens
  failed: boolean
}

/** Tokens consumed outside steps and compactions (e.g. title generation). */
export interface UsageRecord {
  type: "usage"
  ts: number
  sessionID: string
  tokens: Tokens
}

export type StatsRecord = SessionRecord | RequestRecord | ToolRecord | CompactionRecord | UsageRecord

export const zeroTokens = (): Tokens => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  }
}
