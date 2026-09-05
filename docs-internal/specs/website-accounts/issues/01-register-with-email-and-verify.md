# 01 — Register with email and verify it

Status: ready-for-human
Spec: ../spec.md

**What to build:** A player registers with an optional email. The account works at once. A verification mail arrives with a link. Opening the link marks the address verified, and the me endpoint reports it.

**Blocked by:** None — can start immediately.

- [x] Boot schema adds a case-insensitive unique index on `email`, a nullable `email_verified_at`, and an account-token table (user, purpose, hashed token, expiry, consumed stamp). Applies cleanly on an existing database.
- [x] Register accepts an optional email, rejects a taken one with a distinct conflict error, stores it unverified, and sends the verification mail.
- [x] Mail transport module: one `send` shape, a Resend implementation reading `RESEND_API_KEY` and `MAIL_FROM`, and a capture implementation. Injectable for tests, chosen once at startup.
- [x] Public verify endpoint consumes the token once, sets `email_verified_at`, rejects expired and reused tokens.
- [x] Me returns `email` and `emailVerified`.
- [x] Tokens are random, stored hashed, compared by hash.
- [x] Route tests cover: taken email, verification mail captured with a link, consume, expiry, reuse, me state, schema on an existing database.

## Comments

**Implemented.** Two things for review:

- The privacy policy is now wrong. `src/assets/policies/privacy-policy.md` still says the address "is used
  for nothing today" and that "we do not mail it". Flagged as its own task, because rewriting it raises the
  question of whether `acceptance_version` bumps, and because the seeded body only reaches a fresh database
  — the live row has to be edited in the admin Policies tab.
- The unique index on `email` is created by the boot schema and would throw on a database that already
  holds two accounts with the same address. `migrate` is non-fatal at boot, so the server would still serve,
  just without the index. Worth confirming on the box before the deploy:
  `SELECT email, COUNT(*) FROM users WHERE email IS NOT NULL GROUP BY email COLLATE NOCASE HAVING COUNT(*) > 1;`
