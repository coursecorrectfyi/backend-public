/**
 * Trusted relays: servers (the frontend's Next.js server) that call the API on
 * a visitor's behalf and say which visitor (docs/api.md, "Calls from a server").
 *
 * Per-visitor limits are keyed on the client's IP. For a call the browser
 * makes itself, that's the connection's IP (src/lib/client-ip.ts). For a call
 * a server makes for a visitor, it's the server's IP, shared by every visitor.
 * So a relaying server sends:
 *
 *   X-Relay-Secret: <shared secret>   proves the call comes from a trusted relay
 *   X-Visitor-IP:   <one IP address>  the visitor the call is for
 *
 * and the API uses X-Visitor-IP only when the secret is valid. Anyone else
 * sending X-Visitor-IP is ignored: it's as forgeable as X-Forwarded-For.
 *
 * A relay call that goes wrong (wrong secret, missing or invalid visitor IP)
 * is counted under the connection's IP, like any other call, and reported
 * (relay_auth_failed, alert-worthy: visitors are being counted together).
 *
 * TRUSTED_RELAY_SECRETS holds the accepted secrets, separated by spaces or
 * commas: normally one, two while rotating. Each at least 32 characters. Unset
 * means no relay is trusted. Secrets are compared in constant time, and are
 * never logged.
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { clientKeyFromAddress, clientKeyFromChain, isNonPublicAddress } from './client-ip.js'

export const RELAY_SECRET_HEADER = 'X-Relay-Secret'
export const VISITOR_IP_HEADER = 'X-Visitor-IP'
export const MIN_RELAY_SECRET_LENGTH = 32

/** Reads TRUSTED_RELAY_SECRETS. Throws on a secret shorter than MIN_RELAY_SECRET_LENGTH. */
export function readRelaySecrets(): string[] {
  const secrets = (process.env['TRUSTED_RELAY_SECRETS'] ?? '').split(/[\s,]+/).filter(Boolean)
  for (const secret of secrets) {
    if (secret.length < MIN_RELAY_SECRET_LENGTH) {
      // The message must not include the secret.
      throw new Error(
        `TRUSTED_RELAY_SECRETS: each secret must be at least ${MIN_RELAY_SECRET_LENGTH} characters (e.g. openssl rand -base64 48)`,
      )
    }
  }
  return secrets
}

const digest = (value: string) => createHash('sha256').update(value).digest()

/** The accepted relay secrets, compared in constant time. */
export class RelaySecrets {
  private readonly digests: Buffer[]

  constructor(secrets: string[]) {
    this.digests = secrets.map(digest)
  }

  matches(candidate: string): boolean {
    // Fixed-length digests make every comparison take the same time; every
    // secret is compared, so the time doesn't reveal which one matched.
    const given = digest(candidate)
    let match = false
    for (const accepted of this.digests) match = timingSafeEqual(given, accepted) || match
    return match
  }
}

export type RelayProblem = 'invalid_secret' | 'missing_visitor_ip' | 'invalid_visitor_ip' | 'non_public_visitor_ip'

/** Who a request is counted as, for per-visitor limits. */
export interface ClientIdentity {
  /** Client key (IPv4, or IPv6 /64), or null if unknown. */
  key: string | null
  /** True when the key came from a trusted relay's X-Visitor-IP. */
  relayed: boolean
  /**
   * Set when something is wrong with a relay call. For `non_public_visitor_ip`
   * the visitor IP is still used (local development relays 127.0.0.1); for the
   * others the relay was refused and the connection's IP was used instead.
   */
  relayProblem?: RelayProblem
}

/**
 * Decides who a request is counted as: the visitor a trusted relay names, or
 * otherwise the connection's client (TRUST_PROXY_HOPS rules).
 */
export function identifyClient(
  request: { relaySecret?: string; visitorIp?: string; forwardedFor?: string; socketAddress?: string },
  hops: number,
  relays: RelaySecrets,
): ClientIdentity {
  const direct = (relayProblem?: RelayProblem): ClientIdentity => ({
    key: clientKeyFromChain(request.forwardedFor, request.socketAddress, hops),
    relayed: false,
    ...(relayProblem ? { relayProblem } : {}),
  })

  if (request.relaySecret === undefined) return direct()
  if (!relays.matches(request.relaySecret)) return direct('invalid_secret')
  const visitorIp = request.visitorIp?.trim()
  if (!visitorIp) return direct('missing_visitor_ip')
  const key = clientKeyFromAddress(visitorIp)
  if (key === null) return direct('invalid_visitor_ip')
  // A visitor on the internet never has a private or loopback address: the
  // relay probably picked the wrong X-Forwarded-For entry (e.g. its proxy's
  // own address), which would put every visitor in one bucket. Reported.
  if (isNonPublicAddress(visitorIp)) return { key, relayed: true, relayProblem: 'non_public_visitor_ip' }
  return { key, relayed: true }
}
