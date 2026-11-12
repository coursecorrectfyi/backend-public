import 'dotenv/config'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { sql } from 'drizzle-orm'
import { db } from './db/client.js'
import { authRouter } from './api/auth.js'
import { resourcesRouter } from './api/resources.js'
import { savedRouter } from './api/saved.js'
import { subjectsRouter } from './api/subjects.js'
import { chatRouter } from './api/chat.js'

const app = new Hono()

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : ['http://localhost:3001']

app.use('*', cors({
  // Unknown origins get no Access-Control-Allow-Origin header, so the browser blocks them.
  origin: (origin) => allowedOrigins.includes(origin) ? origin : null,
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Session-ID'],
  maxAge: 86400,
}))

app.get('/health', async (c) => {
  try {
    await db.execute(sql`SELECT 1`)
    return c.json({ status: 'ok' })
  } catch (err) {
    // Log the details; don't send them (hosts, usernames) from a public endpoint.
    console.error('[health] database check failed:', err)
    return c.json({ status: 'error', message: 'Database unavailable' }, 503)
  }
})

app.route('/api/v1/auth', authRouter)
app.route('/api/v1/resources', resourcesRouter)
app.route('/api/v1/saved', savedRouter)
app.route('/api/v1/subjects', subjectsRouter)
app.route('/api/v1/chat', chatRouter)

const port = parseInt(process.env.PORT ?? '3000', 10)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
})
