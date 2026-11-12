/**
 * Global test setup: replaces every production dependency with an in-process fake
 * so the suite runs with `npm test` and nothing else: no Postgres server, no GCP
 * credentials, no Firebase project, no network.
 *
 *   Postgres (postgres.js)   -> PGlite: real Postgres compiled to WASM, with pgvector,
 *                               schema built from migrations/*.sql        (fakes/db.ts)
 *   Vertex AI embeddings     -> controllable embedQuery()                 (fakes/embedding.ts)
 *   Gemini (@google/genai)   -> scripted streaming responses              (fakes/genai.ts)
 *   Firebase Admin           -> token table for verifyIdToken()           (fakes/firebase.ts)
 *   @hono/node-server        -> serve() captures the fetch handler and never binds a port
 *   dotenv/config            -> no-op, so a developer's .env never leaks into tests
 *   global fetch             -> throws, so any un-faked network call fails loudly
 */
import { afterEach, beforeEach, vi } from 'vitest'
import { resetEmbeddingFake } from './fakes/embedding.js'
import { resetGenaiFake } from './fakes/genai.js'
import { resetFirebaseFake } from './fakes/firebase.js'

vi.mock('dotenv/config', () => ({}))
vi.mock('@hono/node-server', () => import('./fakes/node-server.js'))
vi.mock('../src/db/client.js', () => import('./fakes/db.js'))
vi.mock('../src/lib/embedding/vertex.js', () => import('./fakes/embedding.js'))
vi.mock('@google/genai', () => import('./fakes/genai.js'))
vi.mock('firebase-admin/app', () => import('./fakes/firebase.js'))
vi.mock('firebase-admin/auth', () => import('./fakes/firebase.js'))

const SHOW_LOGS = process.env.TEST_LOGS === '1'

beforeEach(() => {
  resetEmbeddingFake()
  resetGenaiFake()
  resetFirebaseFake()

  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    throw new Error(`Unexpected network call in tests: ${String(input)}`)
  }))

  // The app logs expected failures (bad tokens, simulated outages) with
  // console.error. Keep test output readable; tests can still assert on these
  // spies. Run with TEST_LOGS=1 to see the output.
  if (!SHOW_LOGS) {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks() // undoes vi.spyOn (console, db failure injection); fakes are reset above
})
