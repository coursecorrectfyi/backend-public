/**
 * Stand-in for firebase-admin/app and firebase-admin/auth (one module serves both).
 *
 * Tests register ID tokens with registerIdToken(token, claims). verifyIdToken()
 * accepts only registered tokens and rejects everything else, like an invalid or
 * expired Firebase token.
 */
import { vi } from 'vitest'
import { singleton } from '../helpers/singleton.js'

export interface FakeDecodedIdToken {
  uid: string
  email?: string
  name?: string
  [claim: string]: unknown
}

const tokens = singleton('firebaseTokens', () => new Map<string, FakeDecodedIdToken>())
const apps = singleton('firebaseApps', () => [] as Array<{ name: string; options: unknown }>)

export function registerIdToken(idToken: string, claims: FakeDecodedIdToken): void {
  tokens.set(idToken, claims)
}

// ── firebase-admin/app ──────────────────────────────────────────────────────
export const applicationDefault = singleton('fbApplicationDefault', () =>
  vi.fn(() => ({ fake: 'application-default-credential' })),
)
export const initializeApp = singleton('fbInitializeApp', () =>
  vi.fn((options: unknown) => {
    const app = { name: '[DEFAULT]', options }
    apps.push(app)
    return app
  }),
)
export function getApps() {
  return [...apps]
}

// ── firebase-admin/auth ─────────────────────────────────────────────────────
export const verifyIdToken = singleton('fbVerifyIdToken', () =>
  vi.fn<(idToken: string) => Promise<FakeDecodedIdToken>>(),
)
export const getAuth = singleton('fbGetAuth', () => vi.fn((_app?: unknown) => ({ verifyIdToken })))

export function resetFirebaseFake(): void {
  tokens.clear()
  apps.length = 0
  initializeApp.mockClear()
  applicationDefault.mockClear()
  getAuth.mockClear()
  verifyIdToken.mockReset()
  verifyIdToken.mockImplementation(async (idToken: string) => {
    const claims = tokens.get(idToken)
    if (!claims) throw new Error('auth/argument-error: Decoding Firebase ID token failed')
    return claims
  })
}
