/** src/lib/relay.ts: trusted relays (a server calling the API for a visitor). */
import { describe, expect, it, vi } from 'vitest'
import {
  MIN_RELAY_SECRET_LENGTH, RelaySecrets, identifyClient, readRelaySecrets,
} from '../../src/lib/relay.js'

const SECRET = 's'.repeat(40)
const OLD_SECRET = 'o'.repeat(40)
const FRONTEND = '34.1.2.3' // the relay's own address, as Cloud Run's front end reports it
const GFE = '169.254.1.1'

describe('readRelaySecrets', () => {
  it.each([[undefined], [''], ['  ']])('trusts no relay when unset (%j)', value => {
    vi.stubEnv('TRUSTED_RELAY_SECRETS', value)
    expect(readRelaySecrets()).toEqual([])
  })

  it.each([[SECRET, [SECRET]], [`${SECRET} ${OLD_SECRET}`, [SECRET, OLD_SECRET]], [`${SECRET},${OLD_SECRET}`, [SECRET, OLD_SECRET]]])(
    'reads one secret, or two while rotating', (value, expected) => {
      vi.stubEnv('TRUSTED_RELAY_SECRETS', value)
      expect(readRelaySecrets()).toEqual(expected)
    },
  )

  it('refuses a secret shorter than 32 characters, without putting it in the error', () => {
    const short = 'tooshort-but-secret'
    vi.stubEnv('TRUSTED_RELAY_SECRETS', `${SECRET} ${short}`)
    expect(MIN_RELAY_SECRET_LENGTH).toBe(32)
    expect(() => readRelaySecrets()).toThrow('each secret must be at least 32 characters')
    try { readRelaySecrets() } catch (err) { expect(String(err)).not.toContain(short) }
  })
})

describe('RelaySecrets', () => {
  it('matches an accepted secret exactly, and nothing else', () => {
    const relays = new RelaySecrets([SECRET])
    expect(relays.matches(SECRET)).toBe(true)
    for (const wrong of ['', SECRET.slice(1), `${SECRET}x`, SECRET.toUpperCase(), OLD_SECRET]) {
      expect(relays.matches(wrong)).toBe(false)
    }
  })

  it('accepts either secret while rotating', () => {
    const relays = new RelaySecrets([SECRET, OLD_SECRET])
    expect(relays.matches(SECRET)).toBe(true)
    expect(relays.matches(OLD_SECRET)).toBe(true)
  })

  it('matches nothing when no secret is configured', () => {
    expect(new RelaySecrets([]).matches('')).toBe(false)
    expect(new RelaySecrets([]).matches(SECRET)).toBe(false)
  })
})

describe('identifyClient', () => {
  const relays = new RelaySecrets([SECRET])
  const through = (headers: { relaySecret?: string; visitorIp?: string }) =>
    identifyClient({ ...headers, forwardedFor: FRONTEND, socketAddress: GFE }, 1, relays)

  it('without a relay secret: the connection\'s client (TRUST_PROXY_HOPS rules)', () => {
    expect(through({})).toEqual({ key: FRONTEND, relayed: false })
  })

  it('ignores X-Visitor-IP without a valid secret: it is as forgeable as X-Forwarded-For', () => {
    expect(through({ visitorIp: '203.0.113.7' })).toEqual({ key: FRONTEND, relayed: false })
  })

  it('with a valid secret: the visitor the relay names', () => {
    expect(through({ relaySecret: SECRET, visitorIp: '203.0.113.7' })).toEqual({ key: '203.0.113.7', relayed: true })
  })

  it('groups a relayed IPv6 visitor by /64, like a direct one', () => {
    expect(through({ relaySecret: SECRET, visitorIp: '2001:db8:1:2::abcd' })).toEqual({ key: '2001:db8:1:2::/64', relayed: true })
  })

  it.each([
    ['a wrong secret', { relaySecret: 'x'.repeat(40), visitorIp: '203.0.113.7' }, 'invalid_secret'],
    ['an empty secret', { relaySecret: '', visitorIp: '203.0.113.7' }, 'invalid_secret'],
    ['no visitor IP', { relaySecret: SECRET }, 'missing_visitor_ip'],
    ['a blank visitor IP', { relaySecret: SECRET, visitorIp: '  ' }, 'missing_visitor_ip'],
    ['a list instead of one address', { relaySecret: SECRET, visitorIp: '203.0.113.7, 198.51.100.1' }, 'invalid_visitor_ip'],
    ['something that is not an address', { relaySecret: SECRET, visitorIp: 'unknown' }, 'invalid_visitor_ip'],
  ] as const)('with %s: the connection\'s client, and the problem', (_label, headers, problem) => {
    expect(through(headers)).toEqual({ key: FRONTEND, relayed: false, relayProblem: problem })
  })

  it('uses but reports a private or loopback visitor IP (the relay probably picked the wrong entry)', () => {
    expect(through({ relaySecret: SECRET, visitorIp: GFE }))
      .toEqual({ key: GFE, relayed: true, relayProblem: 'non_public_visitor_ip' })
    expect(through({ relaySecret: SECRET, visitorIp: '127.0.0.1' }))
      .toEqual({ key: '127.0.0.1', relayed: true, relayProblem: 'non_public_visitor_ip' })
  })
})
