/** src/api/auth-providers.ts: which Firebase sign-in methods may log in. */
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_ALLOWED_PROVIDERS, KNOWN_PROVIDERS, checkSignIn, providerName, readAllowedProviders,
} from '../../src/api/auth-providers.js'

describe('readAllowedProviders', () => {
  it.each([[undefined], [''], ['  ']])('defaults to Google only when unset (%j)', value => {
    vi.stubEnv('AUTH_ALLOWED_PROVIDERS', value)
    expect(DEFAULT_ALLOWED_PROVIDERS).toEqual(['google.com'])
    expect([...readAllowedProviders()]).toEqual(['google.com'])
  })

  it.each([
    ['google.com,github.com', ['google.com', 'github.com']],
    ['google.com github.com', ['google.com', 'github.com']], // spaces: the form used in cloudbuild.api.yaml
    [' google.com , password ,, apple.com ', ['google.com', 'password', 'apple.com']],
    ['oidc.my-idp saml.Corp_1', ['oidc.my-idp', 'saml.Corp_1']],
  ])('reads %j', (value, expected) => {
    vi.stubEnv('AUTH_ALLOWED_PROVIDERS', value)
    expect([...readAllowedProviders()]).toEqual(expected)
  })

  it('accepts every known Firebase provider id', () => {
    vi.stubEnv('AUTH_ALLOWED_PROVIDERS', KNOWN_PROVIDERS.join(','))
    expect(readAllowedProviders().size).toBe(KNOWN_PROVIDERS.length)
  })

  it.each(['google', 'Google.com', 'github', 'email', 'oidc.', 'saml.bad name'])(
    'throws for the unknown id %j instead of silently locking users out', value => {
      vi.stubEnv('AUTH_ALLOWED_PROVIDERS', `google.com,${value}`)
      expect(() => readAllowedProviders()).toThrow('AUTH_ALLOWED_PROVIDERS: unknown provider')
    },
  )

  it.each(['anonymous', 'custom'])('never allows %j', value => {
    vi.stubEnv('AUTH_ALLOWED_PROVIDERS', `google.com ${value}`)
    expect(() => readAllowedProviders()).toThrow(`AUTH_ALLOWED_PROVIDERS must not include "${value}"`)
  })
})

describe('checkSignIn', () => {
  const allowed = new Set(['google.com', 'password'])

  it('allows a listed provider', () => {
    expect(checkSignIn({ firebase: { sign_in_provider: 'google.com' } }, allowed)).toEqual({ allowed: true })
  })

  it.each([
    ['an unlisted provider', { firebase: { sign_in_provider: 'github.com' } }],
    ['an anonymous account', { firebase: { sign_in_provider: 'anonymous' } }],
    ['a token without the claim', {}],
    ['a token with a non-string claim', { firebase: { sign_in_provider: 42 } }],
  ])('refuses %s', (_label, claims) => {
    expect(checkSignIn(claims, allowed)).toEqual({
      allowed: false, status: 403, code: 'provider_not_allowed', error: 'This sign-in method is not supported',
    })
  })

  it.each([[false], [undefined], ['true']])('refuses email/password with email_verified %j', verified => {
    expect(checkSignIn({ firebase: { sign_in_provider: 'password' }, email_verified: verified }, allowed)).toEqual({
      allowed: false, status: 403, code: 'email_not_verified', error: 'Verify your email address before signing in',
    })
  })

  it('allows email/password with a verified email', () => {
    expect(checkSignIn({ firebase: { sign_in_provider: 'password' }, email_verified: true }, allowed)).toEqual({ allowed: true })
  })

  it('does not require a verified email for other providers (many never set it, e.g. GitHub)', () => {
    expect(checkSignIn({ firebase: { sign_in_provider: 'google.com' }, email_verified: false }, allowed)).toEqual({ allowed: true })
  })
})

describe('providerName', () => {
  it.each([
    ['google.com', 'google'],
    ['github.com', 'github'],
    ['apple.com', 'apple'],
    ['password', 'email'],
    ['phone', 'phone'],
    ['oidc.my-idp', 'oidc.my-idp'],
    ['playgames.google.com', 'playgames.google'],
  ])('reports %j as %j', (id, name) => {
    expect(providerName(id)).toBe(name)
  })
})
