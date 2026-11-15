/**
 * Which Firebase sign-in methods may log in (docs/auth-providers.md).
 *
 * Every signed-in account gets its own daily chat questions, so the daily
 * limits are only as strong as accounts are hard to create. A method is
 * allowed only if it's listed in AUTH_ALLOWED_PROVIDERS (default: Google), and
 * email/password accounts must have verified their email address: Firebase
 * lets anyone create those from a script, with any made-up address.
 *
 * Provider ids are Firebase's `firebase.sign_in_provider` token claim, e.g.
 * "google.com", "github.com", "password". They are Firebase-specific: moving
 * to another identity provider means replacing this module and the login
 * route (see "Moving off Firebase Auth" in docs/auth-providers.md).
 */

/** Provider ids Firebase puts in `firebase.sign_in_provider` that may be allowed. */
export const KNOWN_PROVIDERS = [
  'google.com', 'apple.com', 'microsoft.com', 'github.com', 'facebook.com', 'twitter.com', 'yahoo.com',
  'playgames.google.com', 'gc.apple.com', 'password', 'phone',
] as const

/**
 * Never allowed: anonymous Firebase accounts are free and unlimited, and
 * custom tokens are minted by a server we don't run.
 */
const NEVER_ALLOWED = ['anonymous', 'custom']

export const DEFAULT_ALLOWED_PROVIDERS = ['google.com']

/** Email/password (and email link) sign-in; only allowed with a verified email. */
export const PASSWORD_PROVIDER = 'password'

/** OpenID Connect and SAML providers configured in Identity Platform: "oidc.<name>", "saml.<name>". */
const CUSTOM_PROVIDER = /^(oidc|saml)\.[A-Za-z0-9_-]+$/

/**
 * Reads AUTH_ALLOWED_PROVIDERS: provider ids separated by commas and/or spaces
 * (spaces are easier inside gcloud's comma-separated --set-env-vars). Throws on
 * an unknown or forbidden id, so a typo like "google" stops the new revision
 * from starting instead of locking everyone out.
 */
export function readAllowedProviders(): ReadonlySet<string> {
  const raw = process.env['AUTH_ALLOWED_PROVIDERS']?.trim()
  if (!raw) return new Set(DEFAULT_ALLOWED_PROVIDERS)

  const ids = raw.split(/[\s,]+/).filter(Boolean)
  for (const id of ids) {
    if (NEVER_ALLOWED.includes(id)) {
      throw new Error(`AUTH_ALLOWED_PROVIDERS must not include "${id}": those accounts cost nothing to create`)
    }
    if (!(KNOWN_PROVIDERS as readonly string[]).includes(id) && !CUSTOM_PROVIDER.test(id)) {
      throw new Error(
        `AUTH_ALLOWED_PROVIDERS: unknown provider "${id}". Use Firebase provider ids: ${KNOWN_PROVIDERS.join(', ')}, oidc.<name> or saml.<name>`,
      )
    }
  }
  return new Set(ids)
}

export type SignInCheck =
  | { allowed: true }
  | { allowed: false; status: 403; code: 'provider_not_allowed' | 'email_not_verified'; error: string }

/** Decides whether a verified Firebase ID token may log in. */
export function checkSignIn(
  claims: { firebase?: { sign_in_provider?: unknown }; email_verified?: unknown },
  allowed: ReadonlySet<string>,
): SignInCheck {
  const provider = claims.firebase?.sign_in_provider
  if (typeof provider !== 'string' || !allowed.has(provider)) {
    return { allowed: false, status: 403, code: 'provider_not_allowed', error: 'This sign-in method is not supported' }
  }
  if (provider === PASSWORD_PROVIDER && claims.email_verified !== true) {
    return {
      allowed: false, status: 403, code: 'email_not_verified',
      error: 'Verify your email address before signing in',
    }
  }
  return { allowed: true }
}

/**
 * The `provider` reported in the login response: the provider id without
 * ".com" ("google", "github", "apple"), "email" for email/password and email
 * link, otherwise the id itself ("phone", "oidc.<name>").
 */
export function providerName(providerId: string): string {
  if (providerId === PASSWORD_PROVIDER) return 'email'
  return providerId.replace(/\.com$/, '')
}
