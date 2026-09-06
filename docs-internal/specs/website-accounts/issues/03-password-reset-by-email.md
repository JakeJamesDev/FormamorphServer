# 03 — Password reset by email

Status: ready-for-human
Spec: [website accounts](../spec.md)

**What to build:** A player who forgot a password requests a reset by email or username. If the account has a verified email, a link arrives. The link opens a new-password form. Completing it signs out every other session.

**Dependencies:** [01](01-register-with-email-and-verify.md), implemented. Human review remains.

- [x] Public request endpoint takes `account` (email or username), runs both lookups, and returns the same success body for valid requests regardless of account state. It answers before awaiting delivery and sends mail only for a verified address. Reset tokens expire after one hour. Invalid input returns 400; exhausted limits return 429.
- [x] Public complete endpoint takes token plus new password, applies the change-password rules, bumps `token_version`, and marks the token consumed.
- [x] Per-IP auth limiter plus an in-memory limit of three per hour per hashed, trimmed, lowercased submitted identifier. Email and username use separate budgets even when they resolve to the same account; unknown identifiers get the same limit.
- [x] Links point at the site's `/reset-password` page with the raw token in the query.
- [x] Route tests cover: verified, unverified, and unknown accounts answer identically; mail captured only for verified; completion ends an existing session; expired and consumed tokens rejected; limiter trips.

## Review and release

Implemented in `bca6cc3`; reconciled September 6, 2026.

- Request: `POST /api/auth/request-password-reset` with `{ account }`.
- Complete: `POST /api/auth/reset-password` with `{ token, newPassword }`; returns `{ success: true, username }` and no session. All previous sessions end.
- [x] Approved September 6, 2026: retain three reset requests per submitted identifier per hour. Email and username have separate budgets even for the same account.
- [ ] Validate the spec's timing requirement. Existing tests prove identical response bodies and that an unresolved mail transport does not delay the response. They do not prove indistinguishable timing: token creation and database writes still run only for verified accounts after `res.json`, before the handler yields.
- [ ] Complete and deploy [client ticket 07](../../../../../formamorph/docs-internal/specs/website-accounts/issues/07-password-reset-pages.md). The server endpoint is implemented, but the site currently has no reset page.
- [ ] Complete the [live reset check](04-deploy-mail-to-the-box.md).
