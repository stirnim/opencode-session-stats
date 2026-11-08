// session-stats: TUI plugin entry. Wires OpenCode events into the collector,
// records to disk (unless disabled), renders the footer and sidebar views and
// handles the /session-stats command.
//
// Plugin options (cli.json: { "package": "...", "options": { ... } }):
//   record   boolean, default true: write JSONL + summary continuously
//   dataDir  string, default ~/.local/share/opencode-session-stats
//   footer   boolean, default true: show stats in the prompt footer
//   sidebar  boolean, default true: show stats in the sidebar
import { Plugin } from "@opencode/plugin/tui"
import { homedir } from "node:os"
import { join } from "node:path"
import { createMemo } from "solid-js"
import { Collector, type RawEvent } from "./src/collector.ts"
import { COMMAND, parseCommand, USAGE } from "./src/command.ts"
import { debugEnabled, openDebugLog } from "./src/debug-log.ts"
import { buildSummary, expandHome, exportFileName, Recorder, toLine, writeJsonAtomic } from "./src/export.ts"
import type { StatsRecord } from "./src/records.ts"
import { computeStats, rootSession, sessionResolver } from "./src/stats.ts"
import { Footer, Sidebar } from "./src/ui.tsx"
import { PLUGIN_VERSION } from "./src/version.ts"

const DEFAULT_DATA_DIR = join(homedir(), ".local/share/opencode-session-stats")

/** Kept outside Solid's store proxies (class instances aren't wrapped). */
class RecordLog {
  records: StatsRecord[] = []
  /** Root sessions whose earlier JSONL was already loaded in this TUI process. */
  loaded = new Set<string>()
}

export default Plugin.define({
  id: "session-stats",
  setup(context) {
    const record = context.options.record !== false
    const showFooter = context.options.footer !== false
    const showSidebar = context.options.sidebar !== false
    const dataDir = typeof context.options.dataDir === "string" ? expandHome(context.options.dataDir) : DEFAULT_DATA_DIR

    // Memory storage survives plugin hot reloads, so records collected so far
    // are kept when the plugin code changes. `version` signals new records.
    const [state, setState] = context.storage.memory("session-stats", {
      initial: { log: new RecordLog(), version: 0, now: Date.now() },
    })
    // Labels are durable: they survive TUI restarts. Keyed by root session ID.
    const [labels, setLabels] = context.storage.store("labels", {
      initial: { byRoot: {} as Record<string, string> },
    })
    const log = state.log
    const collector = new Collector()
    const debug = debugEnabled() ? openDebugLog(join(dataDir, "debug")) : undefined

    let recorder: Recorder | undefined
    let ioErrorShown = false
    const ioError = (what: string, error: unknown) => {
      console.error(`[session-stats] ${what}`, error)
      if (ioErrorShown) return
      ioErrorShown = true
      context.ui.toast.show({ title: "session-stats", message: `${what}: ${String(error)}`, variant: "error" })
    }
    if (record) {
      try {
        recorder = new Recorder(dataDir)
      } catch (error) {
        ioError(`cannot create ${dataDir}`, error)
      }
    }

    const fallbackDirectory = () => context.data.location.default()?.directory ?? process.cwd()
    const summaryFor = (root: string) =>
      buildSummary(log.records, root, Date.now(), {
        label: labels.byRoot[root],
        opencodeVersion: context.app.version,
        pluginVersion: PLUGIN_VERSION,
        directory: fallbackDirectory(),
      })

    const writeSummaries = (roots: Iterable<string>) => {
      if (!recorder) return
      for (const root of roots) {
        try {
          recorder.writeSummary(summaryFor(root))
        } catch (error) {
          ioError("cannot write summary", error)
        }
      }
    }

    // After a TUI restart, continue the statistics of a session from its JSONL
    // instead of overwriting its summary with partial numbers.
    const loadEarlier = (records: StatsRecord[]) => {
      if (!recorder) return
      const known = sessionResolver(log.records)
      const withNew = sessionResolver([...log.records, ...records])
      const roots = new Set(records.map((r) => withNew.root(r.sessionID)))
      for (const root of roots) {
        if (log.loaded.has(root)) continue
        log.loaded.add(root)
        if (log.records.some((r) => known.root(r.sessionID) === root)) continue
        try {
          log.records.push(...recorder.load(root))
        } catch (error) {
          ioError("cannot read earlier records", error)
        }
      }
    }

    const append = (records: StatsRecord[]) => {
      if (records.length === 0) return
      loadEarlier(records)
      log.records.push(...records)
      if (recorder) {
        const resolve = sessionResolver(log.records)
        const byRoot = new Map<string, object[]>()
        for (const r of records) {
          const root = resolve.root(r.sessionID)
          const line = toLine(r, { label: labels.byRoot[root], rootSessionID: root, parentSessionID: resolve.get(r.sessionID)?.parentSessionID })
          const lines = byRoot.get(root)
          if (lines) lines.push(line)
          else byRoot.set(root, [line])
        }
        for (const [root, lines] of byRoot) {
          try {
            recorder.append(root, lines)
          } catch (error) {
            ioError("cannot append records", error)
          }
        }
        writeSummaries(byRoot.keys())
      }
      setState((s) => void s.version++)
    }

    // Sessions first seen mid-way (plugin started late): fetch the real
    // creation time, parent and directory from the data API.
    const registerLateSessions = (records: StatsRecord[]) => {
      for (const r of records) {
        if (r.type !== "session" || !r.late) continue
        const register = () => {
          const info = context.data.session.get(r.sessionID)
          if (!info) return false
          append(
            collector.registerSession({
              sessionID: info.id,
              parentSessionID: info.parentID,
              created: info.time.created,
              directory: info.location?.directory,
            }),
          )
          return true
        }
        if (!register()) context.data.session.sync(r.sessionID).then(register, () => {})
      }
    }

    const stopEvents = context.data.listen(({ details }) => {
      debug?.write({ recvMs: Date.now(), type: details.type, event: details })
      try {
        const records = collector.apply(details as RawEvent)
        append(records)
        registerLateSessions(records)
      } catch (error) {
        // A bad event must not take down the TUI; skip it.
        console.error("[session-stats] failed to process event", details.type, error)
      }
    })

    // The clock only drives the views (wall clock, waiting time).
    const clock = showFooter || showSidebar ? setInterval(() => setState((s) => void (s.now = Date.now())), 1000) : undefined

    const rootOf = (sessionID: string) => rootSession(log.records, sessionID)
    const hasSession = (root: string) => log.records.some((r) => r.type === "session" && r.sessionID === root)

    /** Stats for the root of `sessionID`, recomputed only when records change. */
    const statsFor = (sessionID: () => string | undefined) =>
      createMemo(() => {
        state.version // dependency: new records
        const id = sessionID()
        if (!id) return undefined
        const root = rootOf(id)
        return hasSession(root) ? computeStats(log.records, root, Date.now()) : undefined
      })
    const now = () => state.now

    const unslotFooter = showFooter
      ? context.ui.slot({
          append: "prompt.footer.status",
          render: (input) => <Footer theme={context.theme} stats={statsFor(() => input.sessionID)} now={now} />,
        })
      : undefined
    const unslotSidebar = showSidebar
      ? context.ui.slot({
          append: "sidebar.content",
          render: (input) => (
            <Sidebar
              theme={context.theme}
              stats={statsFor(() => input.sessionID)}
              now={now}
              label={() => labels.byRoot[rootOf(input.sessionID)]}
            />
          ),
        })
      : undefined

    const toast = (message: string, variant: "info" | "success" | "warning" | "error" = "info") =>
      context.ui.toast.show({ title: "session-stats", message, variant })

    const runCommand = async (input: string | undefined) => {
      const command = parseCommand(input)
      if (command.kind === "help" || command.kind === "unknown") {
        const prefix = command.kind === "unknown" ? `Unknown command: ${command.input}\n\n` : ""
        const recording = recorder ? `Recording to ${context.ui.format.path(dataDir)}` : "Recording is off (option record: false)"
        await context.ui.dialog.alert({ title: "session-stats", message: `${prefix}${USAGE}\n\n${recording}` })
        return
      }
      const route = context.ui.router.current()
      if (route.type !== "session") {
        toast("Open a session first.", "warning")
        return
      }
      const root = rootOf(route.sessionID)

      if (command.kind === "label") {
        await setLabels((draft) => {
          if (command.label) draft.byRoot[root] = command.label
          else delete draft.byRoot[root]
        })
        if (hasSession(root)) writeSummaries([root])
        toast(command.label ? `Label set: ${command.label}` : "Label cleared", "success")
        return
      }

      // export
      if (!hasSession(root)) {
        toast("No statistics for this session yet.", "warning")
        return
      }
      const summary = summaryFor(root)
      const path = join(summary.directory ?? fallbackDirectory(), exportFileName(root, summary.label))
      try {
        writeJsonAtomic(path, summary)
        toast(`Summary written to ${context.ui.format.path(path)}`, "success")
      } catch (error) {
        toast(`Export failed: ${String(error)}`, "error")
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "session-stats.command",
          title: "Session stats: label or export",
          group: "Session stats",
          palette: true,
          slash: { name: COMMAND, arguments: true },
          run: (input) => runCommand(input),
        },
      ],
    }))

    return () => {
      stopEvents()
      clearInterval(clock)
      unslotFooter?.()
      unslotSidebar?.()
      debug?.close()
    }
  },
})
