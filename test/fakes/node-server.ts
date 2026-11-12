/**
 * Stand-in for @hono/node-server. serve() records the fetch handler and port
 * that src/index.ts passes in, so tests can send requests straight to the app
 * without opening a real port.
 */
import { vi } from 'vitest'
import { singleton } from '../helpers/singleton.js'

export type FetchHandler = (request: Request) => Response | Promise<Response>
export interface ServeOptions { fetch: FetchHandler; port?: number }
type ListeningListener = (info: { address: string; family: string; port: number }) => void

export const serve = singleton('serve', () =>
  vi.fn((options: ServeOptions, listeningListener?: ListeningListener) => {
    listeningListener?.({ address: '127.0.0.1', family: 'IPv4', port: options.port ?? 3000 })
    return { close: vi.fn() }
  }),
)
