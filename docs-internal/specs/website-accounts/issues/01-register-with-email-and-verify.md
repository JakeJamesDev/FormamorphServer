# 01 — Register with email and verify it

Status: ready-for-agent
Spec: ../spec.md

**What to build:** A player registers with an optional email. The account works at once. A verification mail arrives with a link. Opening the link marks the address verified, and the me endpoint reports it.

**Blocked by:** None — can start immediately.

- [ ] Boot schema adds a case-insensitive unique index on `email`, a nullable `email_verified_at`, and an account-token table (user, purpose, hashed token, expiry, consumed stamp). Applies cleanly on an existing database.
- [ ] Register accepts an optional email, rejects a taken one with a distinct conflict error, stores it unverified, and sends the verification mail.
- [ ] Mail transport module: one `send` shape, a Resend implementation reading `RESEND_API_KEY` and `MAIL_FROM`, and a capture implementation. Injectable for tests, chosen once at startup.
- [ ] Public verify endpoint consumes the token once, sets `email_verified_at`, rejects expired and reused tokens.
- [ ] Me returns `email` and `emailVerified`.
- [ ] Tokens are random, stored hashed, compared by hash.
- [ ] Route tests cover: taken email, verification mail captured with a link, consume, expiry, reuse, me state, schema on an existing database.
