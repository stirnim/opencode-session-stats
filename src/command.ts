// Parses the arguments of the /session-stats slash command.
export const COMMAND = "session-stats"

export type Command =
  | { kind: "label"; label?: string } // no label: clear it
  | { kind: "export" }
  | { kind: "help" }
  | { kind: "unknown"; input: string }

export const USAGE = [
  `/${COMMAND} label <name>   set the benchmark label (no name: clear it)`,
  `/${COMMAND} export         write the summary JSON into the project directory`,
].join("\n")

export function parseCommand(input: string | undefined): Command {
  // The host may or may not include the command itself in the raw input.
  let rest = (input ?? "").trim()
  for (const prefix of [`/${COMMAND}`, COMMAND]) {
    if (rest === prefix || rest.startsWith(prefix + " ")) {
      rest = rest.slice(prefix.length).trim()
      break
    }
  }
  if (rest === "" || rest === "help") return { kind: "help" }
  const [sub, ...args] = rest.split(/\s+/)
  switch (sub) {
    case "label": {
      const label = args.join(" ").trim()
      return label ? { kind: "label", label } : { kind: "label" }
    }
    case "export":
      return { kind: "export" }
    default:
      return { kind: "unknown", input: rest }
  }
}
