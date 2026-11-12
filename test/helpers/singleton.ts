/**
 * Keeps one instance of a fake per test file, even across `vi.resetModules()`.
 *
 * Some tests re-import `src/index.ts` to re-read env vars at import time. That
 * re-evaluates every module, including the fakes. Storing the instances on
 * globalThis means the re-imported app and the test share the same fake (and the
 * same in-process database) instead of creating fresh ones the test can't see.
 * Each test file runs in its own worker, so nothing leaks between files.
 */
export function singleton<T>(key: string, create: () => T): T {
  const store = globalThis as unknown as Record<string, T | undefined>
  const slot = `__coursecorrect_test_${key}`
  return (store[slot] ??= create())
}
