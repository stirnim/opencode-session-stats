// Footer and sidebar views. They only read SessionStats; all numbers are
// computed elsewhere. Colors come from the TUI theme.
import type { ResolvedTheme } from "@opencode/theme/tui"
import type { RGBA } from "@opentui/core"
import { For, Show, type Accessor, type JSX } from "solid-js"
import { count, duration, MISSING, percent, rate } from "./format.ts"
import type { GroupStats, SessionStats } from "./stats.ts"

interface ViewProps {
  theme: ResolvedTheme
  stats: () => SessionStats | undefined
  now: () => number
}

const wallMs = (s: SessionStats, now: number) => Math.max(0, now - s.startedAt)

/** Value color: faint for missing, error color when `bad` is true. */
function valueColor(theme: ResolvedTheme, text: string, bad = false): RGBA {
  if (text === MISSING) return theme.text.faint
  return bad ? theme.text.feedback.error.base : theme.text.base
}

/** Compact one-liner for prompt.footer.status: wall clock, decode, prefill, tool calls. */
export function Footer(props: ViewProps): JSX.Element {
  const t = props.theme
  const value = (text: () => string, bad?: () => boolean) => (
    <span style={{ fg: valueColor(t, text(), bad?.()) }}>{text()}</span>
  )
  const part = (label: string, text: () => string, bad?: () => boolean) => (
    <>
      <span style={{ fg: t.text.faint }}> · </span>
      <span style={{ fg: t.text.muted }}>{label} </span>
      {value(text, bad)}
    </>
  )
  return (
    <Show when={props.stats()}>
      {(s: Accessor<SessionStats>) => (
        <text>
          {value(() => duration(wallMs(s(), props.now())))}
          {part("dec", () => withUnit(rate(s().total.decodeRate), " t/s"))}
          {part("pre", () => withUnit(rate(s().total.prefillRate), " t/s"))}
          {part("tools", () => toolSummary(s().total), () => s().total.tools.failed > 0)}
        </text>
      )}
    </Show>
  )
}

const withUnit = (value: string, unit: string) => (value === MISSING ? value : value + unit)
const toolSummary = (g: GroupStats) => (g.tools.failed > 0 ? `${g.tools.calls} (${g.tools.failed} failed)` : String(g.tools.calls))

interface RowData {
  label: string
  value: string
  bad?: boolean
  /** Indented detail row; its value is muted unless `bad`. */
  detail?: boolean
}

function Row(props: { theme: ResolvedTheme; row: RowData }): JSX.Element {
  const t = props.theme
  return (
    <box flexDirection="row" justifyContent="space-between" paddingLeft={props.row.detail ? 2 : 0}>
      <text fg={t.text.muted}>{props.row.label}</text>
      <text fg={props.row.detail && !props.row.bad && props.row.value !== MISSING ? t.text.muted : valueColor(t, props.row.value, props.row.bad)}>
        {props.row.value}
      </text>
    </box>
  )
}

function Section(props: { theme: ResolvedTheme; title: string; rows: () => RowData[] }): JSX.Element {
  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={props.theme.text.base}>
        <b>{props.title}</b>
      </text>
      <For each={props.rows()}>{(row) => <Row theme={props.theme} row={row} />}</For>
    </box>
  )
}

function timeRows(s: SessionStats, now: number): RowData[] {
  const wall = wallMs(s, now)
  return [
    { label: "Wall clock", value: duration(wall) },
    { label: "Active", value: duration(s.total.activeMs) },
    { label: "Waiting for user", value: duration(Math.max(0, wall - s.total.activeMs)) },
  ]
}

function rateRows(s: SessionStats): RowData[] {
  const g = s.total
  const rows: RowData[] = [{ label: "Decode", value: withUnit(rate(g.decodeRate), " t/s") }]
  if (s.subAgents.sessions > 0) {
    rows.push({ label: "main", value: withUnit(rate(s.main.decodeRate), " t/s"), detail: true })
    rows.push({ label: "sub-agents", value: withUnit(rate(s.subAgents.decodeRate), " t/s"), detail: true })
  }
  rows.push(
    { label: "Prefill", value: withUnit(rate(g.prefillRate), " t/s") },
    { label: "Cache hit", value: percent(g.cacheHitRate) },
  )
  return rows
}

function requestRows(g: GroupStats): RowData[] {
  const rows: RowData[] = [{ label: "Model requests", value: String(g.requests) }]
  if (g.unstreamedRequests > 0) rows.push({ label: "not streamed", value: String(g.unstreamedRequests), detail: true })
  if (g.failedRequests > 0) rows.push({ label: "failed", value: String(g.failedRequests), bad: true, detail: true })
  if (g.retries > 0) rows.push({ label: "retries", value: String(g.retries), detail: true })
  rows.push({ label: "Tool calls", value: String(g.tools.calls) })
  if (g.tools.calls > 0)
    rows.push({ label: "failed", value: `${g.tools.failed} (${percent(g.tools.failureRate)})`, bad: g.tools.failed > 0, detail: true })
  const byName = Object.entries(g.tools.byName).toSorted((a, b) => b[1].calls - a[1].calls)
  for (const [name, t] of byName)
    rows.push({ label: name, value: t.failed ? `${t.calls} (${t.failed} failed)` : String(t.calls), detail: true })
  return rows
}

function tokenRows(g: GroupStats): RowData[] {
  return [
    { label: "Input", value: count(g.tokens.input) },
    { label: "Output", value: count(g.tokens.output) },
    { label: "Cache read", value: count(g.tokens.cacheRead) },
  ]
}

function subAgentRows(g: GroupStats): RowData[] {
  return [
    { label: "Sessions", value: String(g.sessions) },
    { label: "Requests", value: String(g.requests) },
    { label: "Input / output", value: `${count(g.tokens.input)} / ${count(g.tokens.output)}` },
    { label: "Tool calls", value: String(g.tools.calls), bad: g.tools.failed > 0 },
    { label: "Active", value: duration(g.activeMs) },
  ]
}

/** Statistics panel for sidebar.content. A subset of the recorded stats; the JSON summary has all of them. */
export function Sidebar(props: ViewProps & { label?: () => string | undefined }): JSX.Element {
  const t = props.theme
  return (
    <Show when={props.stats()}>
      {(s: Accessor<SessionStats>) => (
        <box flexDirection="column">
          <text fg={t.text.base}>
            <b>Session stats</b>
          </text>
          <Show when={props.label?.()}>
            {(label: Accessor<string>) => <Row theme={t} row={{ label: "Label", value: label() }} />}
          </Show>
          {/* Only this block depends on the clock, so the rest doesn't re-render every second. */}
          <For each={timeRows(s(), props.now())}>{(row) => <Row theme={t} row={row} />}</For>
          <Section theme={t} title="Rates" rows={() => rateRows(s())} />
          <Section theme={t} title="Activity" rows={() => requestRows(s().total)} />
          <Section theme={t} title="Tokens" rows={() => tokenRows(s().total)} />
          <Show when={s().subAgents.sessions > 0}>
            <Section theme={t} title="Of which sub-agents" rows={() => subAgentRows(s().subAgents)} />
          </Show>
        </box>
      )}
    </Show>
  )
}
