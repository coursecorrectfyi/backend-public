/**
 * Reads a non-negative integer from an environment variable.
 *
 * Unset or empty means `defaultValue`. Anything else that isn't a plain
 * non-negative integer throws, so a typo in deploy config stops the new
 * revision from starting (Cloud Run keeps serving the previous one) instead of
 * silently running with a limit nobody chose.
 */
export function readNonNegativeIntEnv(name: string, defaultValue: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return defaultValue
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`)
  }
  return Number(raw)
}

/**
 * Reads one of a fixed set of values from an environment variable
 * (case-insensitive). Unset or empty means `defaultValue`; anything else
 * throws, for the same reason as readNonNegativeIntEnv.
 */
export function readEnumEnv<T extends string>(name: string, allowed: readonly T[], defaultValue: T): T {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return defaultValue
  const value = allowed.find(v => v === raw)
  if (value === undefined) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${process.env[name]?.trim()}"`)
  }
  return value
}
