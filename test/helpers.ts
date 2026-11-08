import { Collector, type RawEvent } from "../src/collector.ts"
import type { StatsRecord } from "../src/records.ts"

export async function loadEvents(name: string): Promise<RawEvent[]> {
  const text = await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text()
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

export function collect(events: readonly RawEvent[], collector = new Collector()): StatsRecord[] {
  return events.flatMap((e) => collector.apply(e))
}

/**
 * Builds synthetic events with readable relative timestamps.
 * Times are seconds; `created` becomes BASE + seconds * 1000.
 */
export const BASE = 1_800_000_000_000
export const at = (seconds: number) => BASE + Math.round(seconds * 1000)

export function ev(type: string, seconds: number, data: Record<string, unknown> = {}): RawEvent {
  return { type, created: at(seconds), data }
}

export const tokens = (input: number, output: number, cacheRead = 0, reasoning = 0) => ({
  input,
  output,
  reasoning,
  cache: { read: cacheRead, write: 0 },
})

/** A complete streamed request: start → first token → stream end → step end. */
export function streamedStep(opts: {
  session: string
  msg: string
  start: number
  first: number
  end: number
  stepEnd?: number
  input: number
  output: number
  cacheRead?: number
  kind?: "text" | "reasoning"
}): RawEvent[] {
  const { session: sessionID, msg: assistantMessageID } = opts
  return [
    ev("session.step.started", opts.first, {
      sessionID,
      assistantMessageID,
      agent: "build",
      model: { id: "test-model", providerID: "test" },
      started: at(opts.start),
    }),
    ev(`session.${opts.kind ?? "text"}.started`, opts.first, { sessionID, assistantMessageID, ordinal: 0 }),
    ev("session.step.streamed", opts.end, { sessionID, assistantMessageID }),
    ev("session.step.ended", opts.stepEnd ?? opts.end, {
      sessionID,
      assistantMessageID,
      finish: "stop",
      cost: 0,
      tokens: tokens(opts.input, opts.output, opts.cacheRead ?? 0),
    }),
  ]
}
