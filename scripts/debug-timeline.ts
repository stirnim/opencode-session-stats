// Prints a compact per-session timeline from a debug events JSONL file.
// Deltas are collapsed: only the first delta per message (and the count) is shown.
// Usage: bun scripts/debug-timeline.ts <events.jsonl>
const file = Bun.argv[2]
if (!file) throw new Error("usage: bun scripts/debug-timeline.ts <events.jsonl>")

type Rec = { recvMs: number; type: string; event?: any }
const recs: Rec[] = (await Bun.file(file).text())
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))

const t0 = recs.find((r) => r.event)?.event.created ?? 0
const rel = (ms: number) => ((ms - t0) / 1000).toFixed(3).padStart(8)
const short = (id?: string) => (id ? id.slice(-6) : "------")

const DELTAS = new Set(["session.text.delta", "session.reasoning.delta", "session.compaction.delta", "session.tool.input.delta"])
const seenDelta = new Map<string, number>()
const skipped = new Set(["session.viewed", "project.updated", "worktree.resolved", "session.instructions.updated"])

for (const r of recs) {
  const e = r.event
  if (!e) continue
  const d = e.data ?? {}
  if (DELTAS.has(r.type)) {
    const key = `${r.type}:${d.assistantMessageID ?? d.sessionID}`
    const n = (seenDelta.get(key) ?? 0) + 1
    seenDelta.set(key, n)
    if (n > 1) continue
  }
  if (skipped.has(r.type)) continue
  const extra: Record<string, unknown> = {}
  if (d.started !== undefined) extra.started = rel(d.started).trim()
  if (d.parentID) extra.parent = short(d.parentID)
  if (d.finish) extra.finish = d.finish
  if (d.tokens) extra.tokens = d.tokens
  if (d.name) extra.name = d.name
  if (d.id && r.type.startsWith("session.tool")) extra.call = short(d.id)
  if (d.executed !== undefined) extra.executed = d.executed
  if (d.error) extra.error = d.error
  if (d.reason) extra.reason = d.reason
  if (d.source) extra.source = d.source
  if (r.type === "session.tool.success" && d.metadata) extra.meta = d.metadata
  const lag = r.recvMs - e.created
  console.log(
    `${rel(e.created)} +${String(lag).padStart(4)}ms ses:${short(d.sessionID)} msg:${short(d.assistantMessageID)} ${r.type}` +
      (DELTAS.has(r.type) ? " (first)" : "") +
      (Object.keys(extra).length ? " " + JSON.stringify(extra) : ""),
  )
}
console.log("\ndelta counts:")
for (const [k, n] of seenDelta) console.log(`  ${k.replace(/:.*?(\w{6})$/, ":$1")} ${n}`)
