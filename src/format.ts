// Display formatting. Every formatter renders a missing value as "--".
export const MISSING = "--"

/** 850ms, 12.9s, 4m 12s, 1h 04m */
export function duration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return MISSING
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m ${String(totalSeconds % 60).padStart(2, "0")}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  return `${Math.floor(totalMinutes / 60)}h ${String(totalMinutes % 60).padStart(2, "0")}m`
}

/** Tokens per second: 8.4, 86.8, 991, 1210 */
export function rate(tokensPerSecond: number | undefined): string {
  if (tokensPerSecond === undefined || !Number.isFinite(tokensPerSecond)) return MISSING
  return tokensPerSecond < 100 ? tokensPerSecond.toFixed(1) : String(Math.round(tokensPerSecond))
}

/** Token counts: 523, 28.5k, 1.23M */
export function count(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return MISSING
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** 0.5895 → 59% */
export function percent(fraction: number | undefined): string {
  if (fraction === undefined || !Number.isFinite(fraction)) return MISSING
  return `${Math.round(fraction * 100)}%`
}

/** 0.857 → 0.86 */
export function decimal(n: number | undefined, digits = 2): string {
  if (n === undefined || !Number.isFinite(n)) return MISSING
  return n.toFixed(digits)
}
