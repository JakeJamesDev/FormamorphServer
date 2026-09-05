# Spec: Website accounts — email, verification, and password reset

Status: ready-for-agent
Client twin: `formamorph/docs-internal/specs/website-accounts/spec.md`

## Problem Statement

The server has never sent an email. The `email` column exists but no client ever collected it, so every row is empty. A player who forgets a password has no recovery path. The client is adding account pages to formamorph.ai, with password reset, and needs the server to own email as a real, verified field.

## Solution

Email becomes unique and verifiable. Registration and an authenticated endpoint accept an optional email and send a verification link. Password reset works by email, but only to a verified address. Mail goes out through Resend from `noreply@formamorph.ai`, behind an injectable transport so tests capture mail instead of sending it. The reset and verification endpoints are rate-limited in memory, with no IP stored, so the no-IP policy holds.

## User Stories

1. As a player, I want to register with an optional email, so that recovery is possible from day one.
2. As a player, I want a clear error when an email is already taken, so that I know why registration failed.
3. As a player, I want my account usable before I verify my email, so that verification never blocks play.
4. As a player, I want a verification email when I set or change my address, so that only an address I control counts.
5. As a player, I want to resend the verification mail, so that a lost mail is not the end.
6. As a player, I want the me endpoint to report my email and whether it is verified, so that the account page can show it.
7. As a player, I want to request a reset by email or username, so that I can recover with what I remember.
8. As a player, I want the reset request to answer the same way whether the account exists, so that nobody can probe for accounts.
9. As a player, I want a reset email only when my address is verified, so that a typo or a stranger's address never receives my link.
10. As a player, I want the reset link to expire after one hour and work once, so that an old mail cannot be replayed.
11. As a player, I want a completed reset to end every other session, so that whoever had the old password is out.
12. As a player, I want tokens stored hashed, so that a database leak does not hand out working links.
13. As the maintainer, I want the reset and verification endpoints rate-limited per IP and per email in memory, so that abuse is bounded and nothing is persisted or logged.
14. As the maintainer, I want mail through Resend, so that delivery is not the server's job.
15. As the maintainer, I want the transport injectable, so that tests never send real mail.
16. As the maintainer, I want the migration safe on the production database, so that the empty column gains its constraint without a data pass.
17. As the maintainer, I want the API key and sender in the environment file, so that secrets stay off the repo.

## Implementation Decisions

- **Schema.** A case-insensitive unique index on `email` and a nullable `email_verified_at` column on users. A new table holds account tokens: user id, purpose (`verify` or `reset`), hashed token, expiry, consumed stamp. Both changes are boot-schema steps like the existing ones.
- **Register** accepts an optional email. A taken email returns a distinct conflict error. The email is stored unverified and a verification mail is sent. Login works at once.
- **Authenticated email endpoints.** Set or replace email: writes the address, clears `email_verified_at`, sends verification. Resend verification: sends again if unverified. Both sit behind the auth limiter and the new per-email limiter.
- **Verify endpoint.** Public, consumes the token, sets `email_verified_at`, marks the token consumed.
- **Reset request.** Public, takes email or username, always answers success. Sends mail only when the resolved account has a verified email. Reset tokens expire after one hour.
- **Reset complete.** Public, takes token and new password, applies the same password rules as change-password, bumps `token_version` so every session ends, marks the token consumed.
- **Tokens** are random bytes, stored as a hash, compared by hash, single use. Links point at the site's `/verify-email` and `/reset-password` pages with the raw token in the query.
- **Mail transport.** One module with a `send({to, subject, text, html})` shape. The Resend implementation reads `RESEND_API_KEY` and `MAIL_FROM` from the environment. A capture implementation records messages for tests. The transport is chosen once at startup and injectable for tests.
- **Rate limits** use the existing express-rate-limit dependency in its default memory store: a per-IP limiter and a per-email keyed limiter on reset request, verification resend, and email set. No store, no log line.
- **Me** returns `email` and `emailVerified`.
- **Deploy.** The user adds Resend DNS records and the two environment values on the box before the release.

## Testing Decisions

A good test calls a route and asserts the response, the database row, or the captured mail. Nothing asserts internal state.

- **Route tests** at the HTTP seam the existing `tests/*.test.js` files use. Prior art: account deletion and avatar tests.
- **The capture transport is the one new seam.** Tests inject it and assert on the captured message and the link it carries.
- Cases: register with a taken email; verification consume, expiry, and reuse; reset request for verified, unverified, and unknown accounts with identical responses; reset completion ends other sessions; consumed reset token rejected; rate limit trips on the request endpoints; me reports verified state; boot schema applies the new index and column on an existing database.

## Out of Scope

- Login blocked until verification.
- Migrating existing emails. None exist.
- Email-based login.
- OAuth or social sign-in.
- Two-factor authentication (tracked separately).

## Further Notes

- Reset request must not leak timing between known and unknown accounts. Do the same work on both branches.
- Verification links are single use, so a re-sent mail invalidates the earlier token.
