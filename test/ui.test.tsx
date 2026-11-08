// Renders the views headlessly with OpenTUI's test renderer to catch layout
// and formatting mistakes. Colors are not checked (fake theme).
import { describe, expect, test } from "bun:test"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { computeStats, type SessionStats } from "../src/stats.ts"
import { Footer, Sidebar } from "../src/ui.tsx"
import { collect, loadEvents } from "./helpers.ts"

const gray = RGBA.fromHex("#888888")
const theme = {
  text: { base: gray, muted: gray, faint: gray, feedback: { error: { base: gray } } },
} as unknown as ResolvedTheme

const MAIN = "ses_e441cef2effezkTEYTPDNwGO7P"
const records = collect(await loadEvents("run1.events.jsonl"))
const stats = computeStats(records, MAIN, 0)
const now = stats.startedAt + 125_000 // wall clock 2m 05s

async function frame(view: () => any, width: number, height: number) {
  const setup = await testRender(view, { width, height })
  await setup.renderOnce()
  const text = setup.captureCharFrame()
  setup.renderer.destroy()
  return text
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trimEnd()
}

describe("views", () => {
  test("sidebar shows the label", async () => {
    const out = await frame(() => <Sidebar theme={theme} stats={() => stats} now={() => now} label={() => "sqli-run3"} />, 36, 60)
    expect(out).toMatch(/Label\s+sqli-run3/)
  })

  test("footer", async () => {
    const out = await frame(() => <Footer theme={theme} stats={() => stats} now={() => now} />, 80, 1)
    expect(out).toBe("2m 05s · dec 86.8 t/s · pre 991 t/s · tools 6")
  })

  test("footer before the first request shows --", async () => {
    const empty: SessionStats = computeStats(records.filter((r) => r.type === "session"), MAIN, 0)
    const out = await frame(() => <Footer theme={theme} stats={() => empty} now={() => now} />, 80, 1)
    expect(out).toBe("2m 05s · dec -- · pre -- · tools 0")
  })

  test("footer renders nothing without stats", async () => {
    const out = await frame(() => <Footer theme={theme} stats={() => undefined} now={() => now} />, 80, 1)
    expect(out).toBe("")
  })

  test("sidebar", async () => {
    const out = await frame(() => <Sidebar theme={theme} stats={() => stats} now={() => now} />, 36, 60)
    expect(out).toContain("Session stats")
    expect(out).toMatch(/Wall clock\s+2m 05s/)
    expect(out).toMatch(/Active\s+47\.9s/)
    expect(out).toMatch(/Waiting for user\s+1m 17s/)
    expect(out).toMatch(/Not streamed\s+17\.4s/)
    expect(out).toMatch(/main\s+90\.6 t\/s/)
    expect(out).toMatch(/sub-agents\s+69\.3 t\/s/)
    expect(out).toMatch(/Cache hit\s+59%/)
    expect(out).toMatch(/Reasoning\s+n\/a/)
    expect(out).toMatch(/Current\s+--/)
    expect(out).toMatch(/Max\s+10\.4k/)
    expect(out).toMatch(/  failed\s+0 \(0%\)/)
    expect(out).toContain("Of which sub-agents")
    expect(out).toMatch(/Input \/ output\s+17\.1k \/ 400/)
  })
})
