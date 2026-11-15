import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authRouter } from './api/auth.js'
import { resourcesRouter } from './api/resources.js'
import { savedRouter } from './api/saved.js'
import { subjectsRouter } from './api/subjects.js'
import { chatRouter } from './api/chat.js'
import { healthRouter } from './api/health.js'
import { CHAT_LIMITS } from './api/chat-input.js'
import { DEFAULT_MAX_BODY_BYTES, requestBodyLimit } from './api/middleware/body-limit.js'
import { rateLimit, readRateLimitConfig } from './api/middleware/rate-limit.js'
import { proxyHopsCheck } from './api/middleware/proxy-check.js'
import { trustProxyHops } from './lib/client-ip.js'
import { RelaySecrets, readRelaySecrets } from './lib/relay.js'
import { clientIdentity } from './api/middleware/client.js'
import { handleError } from './api/error-handler.js'

const app = new Hono()

// Read once at startup: an invalid value throws, so a bad deploy config stops
// the new revision from starting (see docs/deployment-gcp.md §6).
const TRUST_PROXY_HOPS = trustProxyHops()
const RATE_LIMITS = readRateLimitConfig()
const RELAYS = new RelaySecrets(readRelaySecrets())

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3001']

app.use('*', cors({
  // Unknown origins get no Access-Control-Allow-Origin header, so the browser blocks them.
  origin: (origin) => allowedOrigins.includes(origin) ? origin : null,
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Session-ID'],
  // Browsers only let frontend code read a few "safe" response headers on
  // cross-origin responses (Content-Type, Cache-Control, ...). Every other
  // header it should read must be listed here, or headers.get() returns null
  // even though the header was sent. Retry-After comes with every 429
  // (src/api/limit-responses.ts).
  exposeHeaders: ['Retry-After'],
  maxAge: 86400,
}))

// Everything below is registered after CORS so its error responses (429,
// 413) still carry CORS headers and the browser lets the frontend read them.

// Warns in the logs when TRUST_PROXY_HOPS doesn't match the traffic.
app.use('*', proxyHopsCheck({ hops: TRUST_PROXY_HOPS }))

// Who each request is counted as: the visitor a trusted relay (the Next.js
// server) names with X-Relay-Secret + X-Visitor-IP, or the connection's client.
app.use('*', clientIdentity({ hops: TRUST_PROXY_HOPS, relays: RELAYS }))

// Per-visitor, per-minute limits. Before the body limit, so a flood is turned
// away before any of its bodies are read.
app.use('*', rateLimit(RATE_LIMITS, { hops: TRUST_PROXY_HOPS }))

app.use('*', requestBodyLimit({
  defaultMaxBytes: DEFAULT_MAX_BODY_BYTES,
  routes: { '/api/v1/chat': CHAT_LIMITS.maxBodyBytes },
}))

// Cached for a few seconds and bounded in time (see health.ts)
app.route('/health', healthRouter)

// Anything a route didn't handle: one structured error log, JSON 500 (see error-handler.ts).
app.onError(handleError)

app.route('/api/v1/auth', authRouter)
app.route('/api/v1/resources', resourcesRouter)
app.route('/api/v1/saved', savedRouter)
app.route('/api/v1/subjects', subjectsRouter)
app.route('/api/v1/chat', chatRouter)

const port = parseInt(process.env.PORT ?? '3000', 10)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
