/**
 * Registry of in-memory, per-instance state (rate-limit buckets, log windows).
 *
 * Production never calls resetInstanceState(): the state lives as long as the
 * Cloud Run instance. The test suite calls it before each test, the same way
 * it empties the database, so counts from one test can't leak into the next.
 */

const resets = new Set<() => void>()

/** Registers a function that clears one piece of per-instance state. */
export function registerInstanceState(reset: () => void): void {
  resets.add(reset)
}

/** Clears all registered per-instance state (tests only). */
export function resetInstanceState(): void {
  for (const reset of resets) reset()
}
