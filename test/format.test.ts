import { describe, expect, test } from "bun:test"
import { count, decimal, duration, percent, rate } from "../src/format.ts"

describe("format", () => {
  test("missing values render as --", () => {
    for (const f of [duration, rate, count, percent, decimal]) {
      expect(f(undefined)).toBe("--")
      expect(f(Number.NaN)).toBe("--")
    }
  })

  test("duration", () => {
    expect(duration(850)).toBe("850ms")
    expect(duration(12_949)).toBe("12.9s")
    expect(duration(252_000)).toBe("4m 12s")
    expect(duration(60_000)).toBe("1m 00s")
    expect(duration(3_840_000)).toBe("1h 04m")
  })

  test("rate", () => {
    expect(rate(8.44)).toBe("8.4")
    expect(rate(86.77)).toBe("86.8")
    expect(rate(991.1)).toBe("991")
    expect(rate(1210.4)).toBe("1210")
  })

  test("count", () => {
    expect(count(523)).toBe("523")
    expect(count(28_541)).toBe("28.5k")
    expect(count(1_234_567)).toBe("1.23M")
  })

  test("percent and decimal", () => {
    expect(percent(0.5895)).toBe("59%")
    expect(percent(0)).toBe("0%")
    expect(decimal(6 / 7)).toBe("0.86")
  })
})
