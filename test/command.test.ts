import { describe, expect, test } from "bun:test"
import { parseCommand } from "../src/command.ts"

describe("parseCommand", () => {
  test("label", () => {
    expect(parseCommand("label sqli-codex-run3")).toEqual({ kind: "label", label: "sqli-codex-run3" })
    expect(parseCommand("  label   two words ")).toEqual({ kind: "label", label: "two words" })
    expect(parseCommand("label")).toEqual({ kind: "label" })
  })

  test("export and help", () => {
    expect(parseCommand("export")).toEqual({ kind: "export" })
    expect(parseCommand("")).toEqual({ kind: "help" })
    expect(parseCommand(undefined)).toEqual({ kind: "help" })
    expect(parseCommand("help")).toEqual({ kind: "help" })
  })

  test("input that still contains the command name", () => {
    expect(parseCommand("/session-stats label x")).toEqual({ kind: "label", label: "x" })
    expect(parseCommand("session-stats export")).toEqual({ kind: "export" })
    expect(parseCommand("/session-stats")).toEqual({ kind: "help" })
  })

  test("unknown", () => {
    expect(parseCommand("frobnicate now")).toEqual({ kind: "unknown", input: "frobnicate now" })
  })
})
