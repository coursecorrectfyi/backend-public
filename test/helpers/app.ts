/**
 * Boots the real application (src/index.ts) against the fakes and returns a small
 * client that sends requests straight to its fetch handler (no port is opened).
 */
import { vi } from 'vitest'
import { serve, type FetchHandler } from '../fakes/node-server.js'

export interface TestClient {
  fetch: FetchHandler
  request(path: string, init?: RequestInit): Promise<Response>
  get(path: string, headers?: Record<string, string>): Promise<Response>
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>
  delete(path: string, headers?: Record<string, string>): Promise<Response>
}

function createClient(fetch: FetchHandler): TestClient {
  const request = async (path: string, init?: RequestInit) =>
    fetch(new Request(`http://localhost${path}`, init))
  return {
    fetch,
    request,
    get: (path, headers) => request(path, { headers }),
    post: (path, body, headers) =>
      request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
    delete: (path, headers) => request(path, { method: 'DELETE', headers }),
  }
}

let cached: TestClient | undefined

/** Imports src/index.ts once per test file and reuses the same app afterwards. */
export async function loadApp(): Promise<TestClient> {
  if (cached) return cached
  serve.mockClear()
  await import('../../src/index.js')
  const options = serve.mock.lastCall?.[0]
  if (!options) throw new Error('src/index.ts did not call serve()')
  cached = createClient(options.fetch)
  return cached
}

/**
 * Re-imports src/index.ts (and every module it imports) from scratch. Use it when
 * a test changes env vars that are read at import time (PORT, ALLOWED_ORIGINS)
 * or needs to clear state held in a module (the subjects cache).
 */
export async function loadFreshApp(): Promise<TestClient> {
  vi.resetModules()
  cached = undefined
  return loadApp()
}
