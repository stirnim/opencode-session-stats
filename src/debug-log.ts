// Optional raw event log for troubleshooting and recording new test fixtures.
// Enabled with OPENCODE_SESSION_STATS_DEBUG=1; off by default.
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs"
import { join } from "node:path"

export interface DebugLog {
  write(record: unknown): void
  close(): void
}

export function openDebugLog(dir: string): DebugLog {
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  // One synchronous write per event: nothing is lost if the TUI crashes.
  const fd = openSync(join(dir, `events-${stamp}.jsonl`), "a")
  return {
    write(record) {
      try {
        writeSync(fd, JSON.stringify(record) + "\n")
      } catch {
        // Debug logging must never break the TUI.
      }
    },
    close: () => closeSync(fd),
  }
}

export const debugEnabled = () => process.env.OPENCODE_SESSION_STATS_DEBUG === "1"
