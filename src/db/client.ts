import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from './schema.js'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is not set')

// postgres.js passes unrecognised URL query params as PostgreSQL startup params.
// The ?host=/cloudsql/... format used for Cloud SQL Unix sockets is not a valid
// Postgres startup param, so we must NOT pass it as part of the URL string.
// Instead, detect it and construct the connection config object directly.
const parsedUrl = new URL(connectionString)
const socketPath = parsedUrl.searchParams.get('host')

const queryClient = socketPath
  ? postgres({
      host: socketPath,
      database: parsedUrl.pathname.slice(1), // strip leading /
      username: parsedUrl.username,
      password: decodeURIComponent(parsedUrl.password),
    })
  : postgres(connectionString)

export const db = drizzle(queryClient, { schema })
export type DB = typeof db

/** Call once at process exit to drain the connection pool and allow Node to exit cleanly. */
export async function closeDb(): Promise<void> {
  await queryClient.end()
}
