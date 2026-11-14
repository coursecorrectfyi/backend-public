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
