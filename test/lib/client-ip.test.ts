/** src/lib/client-ip.ts: which client a request came from, behind trusted proxies. */
import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import {
  DEFAULT_TRUST_PROXY_HOPS, clientKey, clientKeyFromAddress, clientKeyFromChain, inspectChain, isNonPublicAddress,
  trustProxyHops,
} from '../../src/lib/client-ip.js'

describe('clientKeyFromAddress', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['  203.0.113.7  ', '203.0.113.7'],
    ['203.0.113.7:51234', '203.0.113.7'], // some proxies append the port
  ])('keeps IPv4 %j as %j', (input, expected) => {
    expect(clientKeyFromAddress(input)).toBe(expected)
  })

  it.each([
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002::1', '2001:db8:1:2::/64'], // leading zeros, upper case
    ['[2001:db8:1:2::1]:443', '2001:db8:1:2::/64'], // bracketed with port
    ['[2001:db8:1:2::1]', '2001:db8:1:2::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'], // zone id
    ['::1', '0:0:0:0::/64'],
    ['::', '0:0:0:0::/64'],
    ['2001:db8::', '2001:db8:0:0::/64'],
    ['64:ff9b::192.0.2.1', '64:ff9b:0:0::/64'], // NAT64, embedded IPv4
  ])('groups IPv6 %j by /64 as %j', (input, expected) => {
    expect(clientKeyFromAddress(input)).toBe(expected)
  })

  it('gives every address in one /64 the same key, and different /64s different keys', () => {
    const a = clientKeyFromAddress('2001:db8:abcd:12::1')
    expect(clientKeyFromAddress('2001:db8:abcd:12:ffff:ffff:ffff:ffff')).toBe(a)
    expect(clientKeyFromAddress('2001:db8:abcd:13::1')).not.toBe(a)
  })

  it.each([
    ['::ffff:198.51.100.4', '198.51.100.4'],
    ['::FFFF:C633:6404', '198.51.100.4'], // same address in hex form
    ['[::ffff:198.51.100.4]:80', '198.51.100.4'],
  ])('treats IPv4-mapped IPv6 %j as IPv4 %j', (input, expected) => {
    expect(clientKeyFromAddress(input)).toBe(expected)
  })

  it.each(['', 'unknown', '1.2.3', '999.1.1.1', '01.2.3.4', 'abc::xyz', '[nope]', '1.2.3.4.5', 'example.com'])(
    'returns null for %j', input => {
      expect(clientKeyFromAddress(input)).toBeNull()
    },
  )
})

describe('clientKeyFromChain', () => {
  // On Cloud Run the socket peer is Google's front end; it appends the
  // visitor's address to X-Forwarded-For after anything the client sent.
  const GFE = '169.254.1.1'

  it('Cloud Run (1 hop): uses the entry the front end appended', () => {
    expect(clientKeyFromChain('203.0.113.7', GFE, 1)).toBe('203.0.113.7')
  })

  it('Cloud Run (1 hop): ignores entries the client wrote itself', () => {
    expect(clientKeyFromChain('192.0.2.66, 192.0.2.77, 203.0.113.7', GFE, 1)).toBe('203.0.113.7')
  })

  it('load balancer + Cloud Run (2 hops): uses the entry before the load balancer', () => {
    expect(clientKeyFromChain('192.0.2.66, 203.0.113.7, 198.51.100.250', GFE, 2)).toBe('203.0.113.7')
  })

  it('no proxy (0 hops): uses the socket address and ignores X-Forwarded-For', () => {
    expect(clientKeyFromChain('192.0.2.66', '203.0.113.7', 0)).toBe('203.0.113.7')
  })

  it('too few hops configured: every visitor gets the proxy address (the shared-IP failure)', () => {
    expect(clientKeyFromChain('203.0.113.7', GFE, 0)).toBe(GFE)
    expect(clientKeyFromChain('198.51.100.9', GFE, 0)).toBe(GFE)
  })

  it('too many hops configured: a client-written entry is used (the spoofing failure)', () => {
    expect(clientKeyFromChain('192.0.2.66, 203.0.113.7', GFE, 2)).toBe('192.0.2.66')
  })

  it('falls back to the furthest address when the chain is shorter than the hops', () => {
    expect(clientKeyFromChain(undefined, '127.0.0.1', 1)).toBe('127.0.0.1') // local dev, no proxy
    expect(clientKeyFromChain('203.0.113.7', GFE, 5)).toBe('203.0.113.7')
  })

  it('ignores empty entries and spacing in the header', () => {
    expect(clientKeyFromChain(' , 192.0.2.66,,  203.0.113.7 ,', GFE, 1)).toBe('203.0.113.7')
  })

  it('returns null when the picked entry is not an IP, without trying other entries', () => {
    expect(clientKeyFromChain('203.0.113.7, garbage', GFE, 1)).toBeNull()
  })

  it('counts an unknown socket address as the last hop', () => {
    expect(clientKeyFromChain('192.0.2.66, 203.0.113.7', undefined, 1)).toBe('203.0.113.7')
    expect(clientKeyFromChain('203.0.113.7', undefined, 0)).toBeNull()
    expect(clientKeyFromChain(undefined, undefined, 1)).toBeNull()
  })

  it('groups IPv6 visitors by /64', () => {
    expect(clientKeyFromChain('2001:db8:1:2::aaaa', GFE, 1)).toBe('2001:db8:1:2::/64')
  })
})

describe('inspectChain', () => {
  const GFE = '169.254.1.1'

  it('counts X-Forwarded-For entries (a normal request through Cloud Run has exactly one)', () => {
    expect(inspectChain('203.0.113.7', GFE, 1)).toEqual({ forwardedCount: 1, picked: '203.0.113.7' })
  })

  it('counts entries the client wrote too, ignoring empty ones', () => {
    expect(inspectChain('192.0.2.66, , 203.0.113.7', GFE, 1)).toEqual({ forwardedCount: 2, picked: '203.0.113.7' })
  })

  it('reports no entries when the header is missing', () => {
    expect(inspectChain(undefined, GFE, 1)).toEqual({ forwardedCount: 0, picked: GFE })
  })

  it('returns the raw picked entry, before parsing', () => {
    expect(inspectChain('garbage', GFE, 1)).toEqual({ forwardedCount: 1, picked: 'garbage' })
    expect(inspectChain(undefined, undefined, 0)).toEqual({ forwardedCount: 0, picked: undefined })
  })
})

describe('isNonPublicAddress', () => {
  it.each([
    '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0',
    '::1', '::', 'fd00::1', 'fc12:3456::1', 'fe80::1', 'fe80::1%eth0', '[::1]:8080', '10.0.0.1:443',
    '::ffff:10.0.0.1', '::ffff:127.0.0.1',
  ])('is true for %j', address => {
    expect(isNonPublicAddress(address)).toBe(true)
  })

  it.each([
    '203.0.113.7', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '2606:4700::1111', '::ffff:8.8.8.8',
  ])('is false for public %j', address => {
    expect(isNonPublicAddress(address)).toBe(false)
  })

  it.each(['', 'garbage', 'example.com'])('is false for non-addresses such as %j', address => {
    expect(isNonPublicAddress(address)).toBe(false)
  })
})

describe('trustProxyHops', () => {
  it('defaults to 1 (Cloud Run)', () => {
    vi.stubEnv('TRUST_PROXY_HOPS', undefined)
    expect(DEFAULT_TRUST_PROXY_HOPS).toBe(1)
    expect(trustProxyHops()).toBe(1)
  })

  it.each([['0', 0], ['2', 2]])('reads %j', (value, expected) => {
    vi.stubEnv('TRUST_PROXY_HOPS', value)
    expect(trustProxyHops()).toBe(expected)
  })

  it('throws on an invalid value', () => {
    vi.stubEnv('TRUST_PROXY_HOPS', 'one')
    expect(() => trustProxyHops()).toThrow('TRUST_PROXY_HOPS must be a non-negative integer, got "one"')
  })
})

describe('clientKey (from a Hono request)', () => {
  function appWithHops(hops: number) {
    const app = new Hono()
    app.get('/', c => c.json({ key: clientKey(c, hops) }))
    return app
  }
  const nodeEnv = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } })

  it('reads X-Forwarded-For and the socket address from @hono/node-server', async () => {
    const app = appWithHops(1)
    const res = await app.request('/', { headers: { 'X-Forwarded-For': '192.0.2.66, 203.0.113.7' } }, nodeEnv('169.254.1.1'))
    expect(await res.json()).toEqual({ key: '203.0.113.7' })
  })

  it('uses the socket address with 0 hops', async () => {
    const res = await appWithHops(0).request('/', {}, nodeEnv('::ffff:198.51.100.4'))
    expect(await res.json()).toEqual({ key: '198.51.100.4' })
  })

  it('treats the socket as unknown when the runtime does not provide it', async () => {
    const res = await appWithHops(0).request('/')
    expect(await res.json()).toEqual({ key: null })
  })
})
