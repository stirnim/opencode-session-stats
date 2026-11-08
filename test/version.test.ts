import { expect, test } from "bun:test"
import { PLUGIN_VERSION } from "../src/version.ts"

test("PLUGIN_VERSION matches package.json", async () => {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json()
  expect(PLUGIN_VERSION).toBe(pkg.version)
})
