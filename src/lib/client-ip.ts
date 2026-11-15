/**
 * Works out which client a request came from, for per-client limits.
 *
 * Behind a reverse proxy the TCP peer is the proxy, not the visitor. Each proxy
 * appends the address that connected to it to X-Forwarded-For, so the header
 * reads "<anything the client wrote>, <added by proxy 1>, <added by proxy 2>".
 * Only entries added by our own proxies can be trusted.
 *
 * TRUST_PROXY_HOPS is the number of proxies between the internet and this
 * process (the same rule as Express's `trust proxy` setting). The client is
 * the address that many hops in from the right of
 * [...X-Forwarded-For entries, socket address]:
 *
 *   Cloud Run (Google Front End):                1
 *   Cloud Load Balancing / a CDN + Cloud Run:    2
 *   No proxy (local `npm run dev`, bare VM):     0
 *
 * Too low  -> the proxy's own address is used: every visitor shares one limit.
 * Too high -> an entry the client wrote is used: limits can be bypassed.
 * See docs/deployment-gcp.md ("Client IP and abuse limits") before changing
 * anything in front of the API.
 *
 * IPv6 clients are grouped by /64: one home or phone usually gets a whole /64,
 * so counting single addresses would let one client rotate through billions.
 */

import { BlockList, isIP } from 'node:net'
import type { Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { readNonNegativeIntEnv } from './env.js'

export const DEFAULT_TRUST_PROXY_HOPS = 1

/** TRUST_PROXY_HOPS from the environment (default 1, for Cloud Run). */
export function trustProxyHops(): number {
  return readNonNegativeIntEnv('TRUST_PROXY_HOPS', DEFAULT_TRUST_PROXY_HOPS)
}

/** Expands a valid IPv6 address (no zone, no brackets) into its 8 16-bit groups. */
function ipv6Groups(address: string): number[] {
  let text = address
  // Embedded IPv4 tail, e.g. 64:ff9b::192.0.2.1 -> two hex groups
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = text.split('::') as [string, string | undefined]
  const parse = (part: string) => (part ? part.split(':').map(g => parseInt(g, 16)) : [])
  const left = parse(head)
  const right = tail === undefined ? [] : parse(tail)
  const zeros = tail === undefined ? [] : new Array<number>(8 - left.length - right.length).fill(0)
  return [...left, ...zeros, ...right]
}

interface ParsedAddress {
  /** IPv4 dotted form (IPv4-mapped IPv6 is converted), or lowercase IPv6 */
  address: string
  family: 'ipv4' | 'ipv6'
  /** The 8 groups, for IPv6 only */
  groups?: number[]
}

/**
 * Parses one address as found in X-Forwarded-For or on the socket: strips
 * brackets, a port and an IPv6 zone id. IPv4-mapped IPv6 (::ffff:192.0.2.4)
 * counts as IPv4. Returns null for anything that isn't an IP address.
 */
function parseAddress(raw: string): ParsedAddress | null {
  let address = raw.trim()
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address) // [v6] or [v6]:port
  if (bracketed) address = bracketed[1]!
  const v4WithPort = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(address)
  if (v4WithPort) address = v4WithPort[1]!
  address = address.replace(/%.*$/, '') // IPv6 zone id (fe80::1%eth0)

  const version = isIP(address)
  if (version === 4) return { address, family: 'ipv4' }
  if (version !== 6) return null

  address = address.toLowerCase()
  const groups = ipv6Groups(address)
  const isV4Mapped = groups.slice(0, 5).every(g => g === 0) && groups[5] === 0xffff
  if (isV4Mapped) {
    const v4 = [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join('.')
    return { address: v4, family: 'ipv4' }
  }
  return { address, family: 'ipv6', groups }
}

/**
 * Turns one address (as found in X-Forwarded-For or on the socket) into the
 * key limits are counted under: the IPv4 address itself, or the IPv6 /64
 * prefix ("2001:db8:1:2::/64"). IPv4-mapped IPv6 (::ffff:192.0.2.4) counts as
 * IPv4. Returns null for anything that isn't an IP address.
 */
export function clientKeyFromAddress(raw: string): string | null {
  const parsed = parseAddress(raw)
  if (!parsed) return null
  if (parsed.family === 'ipv4') return parsed.address
  return `${parsed.groups!.slice(0, 4).map(g => g.toString(16)).join(':')}::/64`
}

/**
 * Addresses a visitor's request can't come from on the public internet:
 * private networks, loopback, link-local (Cloud Run's front end connects from
 * 169.254.x.x), carrier-grade NAT and "this network".
 */
const NON_PUBLIC = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
] as const) NON_PUBLIC.addSubnet(net, prefix, 'ipv4')
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10]] as const) {
  NON_PUBLIC.addSubnet(net, prefix, 'ipv6')
}

/**
 * True if `raw` is a private, loopback or link-local address. Picking one as
 * the client means a proxy's own address was used: TRUST_PROXY_HOPS is too low.
 */
export function isNonPublicAddress(raw: string): boolean {
  const parsed = parseAddress(raw)
  return parsed !== null && NON_PUBLIC.check(parsed.address, parsed.family)
}

/** What the proxy chain of one request looks like (see clientKeyFromChain). */
export interface ChainInfo {
  /** Number of X-Forwarded-For entries. Browsers send none, so normally one per proxy. */
  forwardedCount: number
  /** The address TRUST_PROXY_HOPS points at, before parsing. */
  picked: string | undefined
}

/**
 * Builds the chain [...X-Forwarded-For entries, socket address] and picks the
 * address `hops` places from the right. `socketAddress` is undefined when
 * the runtime doesn't expose it; it still counts as the last hop.
 */
export function inspectChain(
  forwardedFor: string | undefined,
  socketAddress: string | undefined,
  hops: number,
): ChainInfo {
  const forwarded = (forwardedFor ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const chain: Array<string | undefined> = [...forwarded, socketAddress]
  // More hops than addresses: the request didn't pass through all the proxies
  // we expect; the furthest address is the best we have (as Express does).
  return { forwardedCount: forwarded.length, picked: chain[Math.max(0, chain.length - 1 - hops)] }
}

/**
 * Picks the client address from the X-Forwarded-For header value and the
 * socket address, trusting `hops` proxies, and returns its client key.
 */
export function clientKeyFromChain(
  forwardedFor: string | undefined,
  socketAddress: string | undefined,
  hops: number,
): string | null {
  const { picked } = inspectChain(forwardedFor, socketAddress, hops)
  return picked === undefined ? null : clientKeyFromAddress(picked)
}

/** The socket (TCP peer) address, or undefined if the runtime doesn't expose it. */
export function socketAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address
  } catch {
    // Not running on @hono/node-server (or no socket): treated as unknown.
    return undefined
  }
}

/** The client key for a request (see clientKeyFromChain), or null if unknown. */
export function clientKey(c: Context, hops: number): string | null {
  return clientKeyFromChain(c.req.header('X-Forwarded-For'), socketAddress(c), hops)
}
