# opencode-session-stats

A TUI plugin for [OpenCode](https://opencode.ai) v2 that shows and records
**per-session statistics**: decode and prefill rates, time to first token, where
the time went, tool calls, tokens and context size, including sub-agents.

It is built for benchmarking: judging how fast a (local) model really is in agentic
work, and comparing agent harnesses on the same task. It measures completed requests
from exact token counts. It does not estimate anything live while a response streams.

```
2m 05s · dec 86.8 t/s · pre 991 t/s · tools 6
```

<details>
<summary>Sidebar</summary>

```
Session stats
Label                      sqli-run3
Wall clock                    2m 05s
Active                         47.9s
Waiting for user              1m 17s

Time split
Prefill (Σ TTFT)               13.0s
Decode                         22.7s
Tools                          26.4s
Not streamed                   17.4s

Rates
Decode                      86.8 t/s
  main                      90.6 t/s
  sub-agents                69.3 t/s
Prefill                      991 t/s
Avg TTFT                        2.6s
Cache hit                        59%

Activity
Model requests                     7
  not streamed                     2
Tool calls                         6
  failed                      0 (0%)
  per request                   0.86
  read                             2
  shell                            2
  subagent                         2

Tokens
Input                          28.5k
Output                          3.1k
  Reasoning                      n/a
Cache read                     41.0k

Context
Current                           --
Max                            10.4k
Compactions                        1

Of which sub-agents
Sessions                           2
Requests                           4
Input / output           17.1k / 400
Tool calls                         2
Active                         14.1s
```

</details>

## Requirements

- OpenCode v2. Developed and tested against **v2.2.6** (`@opencode/plugin` 2.2.6).
- Nothing else at runtime: OpenCode transpiles the TSX and provides Solid and OpenTUI.
  [Bun](https://bun.sh) is only needed for development.

## Installation

Clone the repository, then make it visible to OpenCode in one of these ways:

```sh
git clone https://github.com/stirnim/opencode-session-stats.git ~/src/opencode-session-stats

# a) for all projects
ln -s ~/src/opencode-session-stats ~/.config/opencode/plugins/session-stats

# b) for one project only
mkdir -p .opencode/plugins
ln -s ~/src/opencode-session-stats .opencode/plugins/session-stats
```

Options can only be passed through an entry in `~/.config/opencode/cli.json`. Use
that instead of a symlink if you need them:

```json
{
  "plugins": [
    { "package": "/Users/you/src/opencode-session-stats", "options": { "record": false } }
  ]
}
```

Restart the TUI afterwards.

## Usage

- **Footer** (appended to the prompt status line): wall clock, average decode rate,
  average prefill rate, tool calls.
- **Sidebar**: all statistics, with a breakdown for sub-agents. Missing values show as
  `--` (e.g. rates before the first request).
- Stats always cover the **root session and all its sub-agents**, so they stay the same
  when you navigate into a sub-agent session.

### Command

`/stats` is taken by OpenCode's built-in usage statistics, so the command is
`/session-stats`:

| Command | Effect |
|---|---|
| `/session-stats label <name>` | Set a label for a benchmark run, e.g. `sqli-codex-run3`. Written to the JSONL from then on and to the summary; shown in the sidebar; kept across TUI restarts. |
| `/session-stats label` | Clear the label. |
| `/session-stats export` | Write the summary to `session-stats-<label or sessionID>.json` in the session's project directory. Works with recording turned off, too. |
| `/session-stats` | Show help. |

### Options

| Option | Default | Description |
|---|---|---|
| `record` | `true` | Write the JSONL and summary files continuously. With `false` nothing is written; stats are only displayed (`/session-stats export` still works, covering what happened since the TUI started). |
| `dataDir` | `~/.local/share/opencode-session-stats` | Where recordings go. `~` is expanded. |
| `footer` | `true` | Show the stats in the prompt footer. |
| `sidebar` | `true` | Show the stats panel in the sidebar. |

With `"footer": false, "sidebar": false` nothing is displayed and the plugin only
records (and still answers `/session-stats`).

Environment variable `OPENCODE_SESSION_STATS_DEBUG=1` additionally logs every raw
OpenCode event to `<dataDir>/debug/events-<time>.jsonl` (includes session content).

## Recorded files

One pair of files per root session in `dataDir`. They are written while the session
runs, because the TUI has no reliable "session ended" moment.

**`<sessionID>.jsonl`**: append-only, one line per completed record. All statistics
can be recomputed from this file (`parseRecords` + `computeStats` in `src/`).
Line types: `session`, `request`, `compaction`, `usage` (tokens spent outside requests,
e.g. title generation) and `tool` (rare: a tool call that finished after its request
was recorded). A request line:

```json
{"type":"request","ts":1794157702657,"sessionID":"ses_…","messageID":"msg_…",
 "provider":"m5","model":"deepseek-v4.1-flash","variant":"high","agent":"build",
 "requestStart":1794157702189,"firstToken":1794157702402,"requestEnd":1794157702656,
 "stepEnd":1794157702657,"streamed":true,"hasReasoning":true,"ttftMs":213,"decodeMs":254,
 "tokens":{"input":53,"output":28,"reasoning":0,"cacheRead":8152,"cacheWrite":0},
 "finish":"stop","failed":false,"interrupted":false,"retries":0,
 "toolCalls":[{"callID":"call_…","tool":"read","startMs":1794157702660,"endMs":1794157702668,"ok":true}],
 "contextTokens":8233,"parentSessionID":null,"isSubAgent":false,"label":"sqli-run3"}
```

Times are Unix milliseconds (OpenCode server clock). Missing values are `null`.

**`<sessionID>.json`**: the current summary, rewritten atomically (temp file + rename)
after every change: `summaryVersion`, `sessionID`, `label`, `directory`,
`opencodeVersion`, `pluginVersion`, `startedAt`, `lastActivity`, `updatedAt` (ISO) and
`stats` with `total`, `main` and `subAgents` (same shape each), `wallMs` and `context`.

After a TUI restart, a resumed session's earlier JSONL is loaded again, so its summary
continues instead of starting over.

## How it measures

Everything is derived from OpenCode v2 events (`context.data.listen`), timestamped
with the event's server time.

**Request**: one model call (an OpenCode *step*, i.e. one assistant message). A
follow-up call after tool results is a new request.

| Moment | Event |
|---|---|
| Request start | `session.step.started` → `data.started` |
| First token | earliest `session.reasoning.started` / `session.text.started` / `session.tool.input.started` |
| Request end (decode end) | `session.step.streamed` |
| Tokens | `session.step.ended` → `data.tokens` |

`session.step.ended` is **not** the decode end: it waits until the step's tool calls,
including sub-agents, have finished. Text deltas are batched by OpenCode (about every
100 ms), so the first delta would be late; the `*.started` events mark the first token.

**Definitions**

- **TTFT** = first token − request start. **Decode time** = request end − first token.
  Reasoning counts as decode.
- **Prefill tokens** = `tokens.input`. OpenCode v2 reports `input` *without* cache reads;
  the full prompt is `input + cacheRead`.
- **Decode rate** = Σ output tokens / Σ decode time. **Prefill rate** = Σ prefill
  tokens / Σ TTFT. Both are weighted sums, not means of per-request rates. Output
  includes reasoning.
- **Avg TTFT** = Σ TTFT / number of requests. **Cache hit rate** = Σ cacheRead /
  Σ (input + cacheRead).
- **Active time** = union of all busy intervals (request start → request end, tool
  execution, compaction), so parallel sub-agents are not counted twice.
  **Waiting for user** = wall clock − active time. **Time split** sums TTFT, decode and
  tool time (a sum, so parallel tools add up).
- **Context** = `input + cacheRead + output` of the main session's last request; unknown
  (`--`) right after a compaction until the next request.
- **Sub-agents** are linked through `session.created` → `parentID` (nested sub-agents
  too). They are included in all totals and also shown separately.

**What is excluded from which number**

| Case | Counted in requests, tokens, active time | Avg TTFT, prefill rate | Decode rate |
|---|---|---|---|
| Normal streamed request | yes | yes | yes |
| Request without streamed output (tool call only, provider doesn't stream tool arguments) | yes | no | no |
| Retried request (TTFT includes the backoff) | yes | no | yes |
| Failed or interrupted request | yes | no | no |
| Title generation, compaction (no step events) | tokens only; compaction also in active time | no | no |

A **failed tool call** is a `session.tool.failed` event. A shell command exiting with a
non-zero code is a normal result, not a failure.

**Caveats**

- If the inference server handles one request at a time, TTFT includes the time a
  request waits in its queue (e.g. behind a parallel sub-agent or the title request).
  The events can't separate this, so the prefill rate looks lower than it is.
- Some providers don't report reasoning tokens separately (e.g. mlx-serve through the
  OpenAI-compatible provider). The sidebar then shows `n/a`; the reasoning is part of
  the output count.
- Whether `input` excludes cache reads for every provider is only verified for the
  OpenAI-compatible provider.
- A resumed session's stats appear with its first new event after a TUI restart, not
  when it is opened.
- If the plugin starts in the middle of a session, earlier requests are missing unless
  they were recorded before.

## Development

```sh
bun install       # dev dependencies only (types, test renderer)
bun test          # unit, fixture and headless render tests
bun run typecheck
```

| Path | Content |
|---|---|
| `tui.tsx` | Plugin entry: events, recording, slots, command |
| `src/collector.ts` | Raw events → records (stateful, no I/O) |
| `src/stats.ts` | Records → statistics (pure) |
| `src/export.ts` | JSONL, summary, atomic writes |
| `src/ui.tsx`, `src/format.ts` | Footer and sidebar views, number formatting |
| `src/command.ts` | `/session-stats` argument parsing |
| `test/fixtures/` | A recorded OpenCode run (content removed) |
| `scripts/debug-timeline.ts` | Prints a debug event log as a per-session timeline |

The repository contains `.opencode/plugins/session-stats` (a symlink to itself), so
starting OpenCode in the repository loads the working copy.

To record a new fixture, run OpenCode with `OPENCODE_SESSION_STATS_DEBUG=1`, inspect
it with `bun scripts/debug-timeline.ts <file>`, and strip all content (prompts, text,
deltas, tool input/output) before committing it.

## License

[MIT](LICENSE)
