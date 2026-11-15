# Sign-in methods: choosing and adding them

Users sign in with Firebase Authentication in the browser. The backend exchanges the Firebase ID token for its own
tokens at [`POST /api/v1/auth/firebase/login`](api.md#post-apiv1authfirebaselogin). This guide covers which sign-in
methods are safe to offer, and everything to do, across Firebase, the frontend, the backend and operations, to add one.

## Why the choice matters for cost

Every signed-in account gets **10 chat questions a day**, and each question is a paid Gemini call. The per-user limit is
only meaningful if accounts are costly to create: if someone can create accounts from a script, they get 10 questions
per account, without limit. Two backend rules keep that in check:

- **Only listed methods can log in** (`AUTH_ALLOWED_PROVIDERS`, default `google.com`). Anything else gets
  `403 provider_not_allowed`, and no user is created. Anonymous Firebase accounts are never allowed (the setting refuses
  to start with them).
- **Email/password accounts must verify their email first** (`403 email_not_verified` otherwise). Firebase lets anyone
  create email/password accounts with any made-up address, using the public web API key from a script. Verification
  requires a working inbox for each account.

The backstop is the **daily total for all signed-in questions** (`SIGNED_IN_GLOBAL_DAILY_LIMIT`, default 1,000). It caps
the damage if a method turns out cheaper to abuse than expected. When it's reached, chat is off for every signed-in user
until midnight UTC, and the log alert in [monitoring.md §5](monitoring.md#5-one-log-alert-for-abuse-and-configuration-signals) fires.

The backend code and its limits don't depend on which methods you offer: everything keys on the Firebase UID. Adding a
method is a configuration change plus the steps below.

## Choosing methods

| Method | Firebase provider id | Cost to offer | How easy to abuse (create many accounts) | Notes |
|---|---|---|---|---|
| Google | `google.com` | free | hard: Google rate-limits account creation and often asks for a phone number | enabled today. Email always verified |
| Microsoft | `microsoft.com` | free (app registration in Microsoft Entra) | moderate | personal and work accounts. The email may be unverified (not required by the backend) |
| GitHub | `github.com` | free (GitHub OAuth app) | moderate: free accounts, email verification required by GitHub | the email may be missing if the user keeps it private |
| Apple | `apple.com` | **$99/year** (Apple Developer Program) | hard | users can hide their email (a relay address). Apple sends the name only on the first sign-in |
| Email/password | `password` | free | **easy without verification**: the backend requires a verified email | also used by Firebase's passwordless email-link sign-in, which verifies the email by design |
| Facebook | `facebook.com` | free, but Meta's app review and business verification take time | moderate | |
| X (Twitter) | `twitter.com` | depends on X's current developer API terms | moderate | check X's terms before committing |
| Yahoo | `yahoo.com` | free | moderate | |
| Phone (SMS) | `phone` | **billed per SMS** | moderate, and a target for SMS fraud (bots triggering texts to premium numbers at your expense) | **avoid**, unless there's a strong reason and SMS region limits are set |
| Anonymous | `anonymous` | free | trivial | **never**: the backend refuses it |
| OIDC / SAML (e.g. a university's login) | `oidc.<name>`, `saml.<name>` | needs the Identity Platform upgrade, which has its own free tier and per-user pricing | low | for institutional logins |

Firebase Authentication itself doesn't charge for the social and email methods at normal volumes; phone sign-in and
the Identity Platform upgrade have their own pricing. Check the current [Firebase pricing](https://firebase.google.com/pricing)
before enabling one of those.

Recommendation for "as many free users as possible": Google (done), then Microsoft and GitHub, then email/password
(with verification, already enforced) or email link. Skip phone and anonymous.

## Adding a method: checklist

Do it in this order. Each step is harmless on its own, so users never see a sign-in button that gets refused.

### 1. Backend: allow it (harmless until the method is enabled in Firebase)

- [ ] Add the provider id to `_AUTH_ALLOWED_PROVIDERS` in `cloudbuild.api.yaml`, **separated by spaces** (commas would
      break `--set-env-vars`), e.g. `'google.com github.com password'`, and deploy. An unknown id (e.g. `github`
      instead of `github.com`) stops the new revision from starting, and Cloud Run keeps the previous one.
      To allow it at once without a build: `gcloud run services update <service> --update-env-vars=AUTH_ALLOWED_PROVIDERS="google.com github.com"`
      (and still update the yaml, or the next deploy removes it).
- [ ] Add a test in `test/api/auth.test.ts` with that provider's token claims (provider id, with and without email or
      name), so `user.provider` and the profile fields are covered.

### 2. Firebase console (Authentication)

- [ ] **Sign-in method** → enable the provider. For OAuth providers, register an app with the provider (GitHub OAuth
      app, Microsoft Entra app, Meta app, Apple Services ID + key) and paste its client id and secret. Register Firebase's
      redirect URL (shown on the same screen) with the provider.
- [ ] **Settings → Authorized domains:** the site's domain(s) are listed.
- [ ] **Settings → User account linking:** keep **"Link accounts that use the same email"** (one account per email).
      Otherwise someone who signs in with Google and GitHub using the same email gets two accounts, and two sets of
      daily questions.
- [ ] Email/password only:
  - **Templates → Email address verification:** sender name, subject, and the link's action URL.
  - **Settings → User actions:** keep **email enumeration protection** on (the default for new projects).
  - If your project shows a per-IP **sign-up quota**, keep it low (e.g. a few accounts per IP per hour).
  - Consider a password policy (minimum length).

### 3. Frontend

What the client must do follows from the [API contract](api.md#post-apiv1authfirebaselogin):
- [ ] A sign-in button for the method (Firebase JS SDK).
- [ ] Handle Firebase's `auth/account-exists-with-different-credential` (the email already belongs to an account from
      another method): ask the user to sign in with the original method, then link.
- [ ] Email/password: sign-up form, `sendEmailVerification()` after sign-up, a "check your inbox" state, password reset.
      **Only call the backend login once the email is verified**, with a **fresh** ID token (`user.reload()` then
      `getIdToken(true)`): the verified flag is part of the token, and an old token still says "not verified".
- [ ] Handle `403 provider_not_allowed` and `403 email_not_verified` from login (show the `error` text; for
      `email_not_verified`, offer to resend the verification email).
- [ ] Don't assume `email`, `firstName` or `lastName` are present, or that `provider` is `"google"`.

### 4. Privacy and terms

- [ ] The privacy policy lists the new identity provider (it receives and sends personal data) and what's stored:
      the Firebase UID and the email address, if the provider gives one ([operations.md §5](operations.md#5-privacy-and-compliance)).

### 5. After release

- [ ] Sign in once with the new method on the live site.
- [ ] Watch sign-ups per method for the first weeks. Each new account logs `user_signed_up` with its `provider`, and each
      refused login logs `login_rejected` with a `reason` ([monitoring.md](monitoring.md#log-events-reference)):
      ```sh
      gcloud logging read 'resource.type="cloud_run_revision" AND jsonPayload.event="user_signed_up"' \
        --project=$PROJECT_ID --freshness=7d --format='value(timestamp, jsonPayload.provider)'
      ```
      A sudden spike of sign-ups from one method, without matching real usage, is what account-creation abuse looks like.
- [ ] Keep an eye on the signed-in total against real use
      ([operations.md §3](operations.md#3-regular-review-eg-monthly)), and raise `SIGNED_IN_GLOBAL_DAILY_LIMIT` before
      real traffic reaches it.

## Removing a method

Remove its id from `AUTH_ALLOWED_PROVIDERS` (and disable it in Firebase). New logins with it get
`403 provider_not_allowed` at once. Sessions that already exist keep working until their refresh token expires (up to 7
days): backend tokens can't be revoked today. Users who only have that method lose access, unless their account is
linked to another method.

## Moving off Firebase Auth

Firebase is used in one place: the login exchange. Everything after login uses the backend's own JWTs, which don't
depend on the identity provider.

| Firebase-specific | Where |
|---|---|
| Verifying the ID token, Firebase Admin setup | `src/api/auth.ts` (`verifyIdToken`, `initializeApp`) |
| Provider ids and the sign-in rules | `src/api/auth-providers.ts` (`firebase.sign_in_provider`, `email_verified`) |
| The user id is the Firebase UID | `users.firebase_uid` (primary key), `saved_courses.user_id`, `chat_usage.identity` for `user` rows, and the JWT `sub` |

A move means a new login exchange for the new provider (same response shape), and keeping each existing user's id
stable: either map each new-provider identity to the old Firebase UID, or migrate the three places above to a new id.
Sign-in UI changes on the frontend. The limits, chat, saved courses and tokens are unaffected.
