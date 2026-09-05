# 03 — Password reset by email

Status: ready-for-agent
Spec: ../spec.md

**What to build:** A player who forgot a password requests a reset by email or username. If the account has a verified email, a link arrives. The link opens a new-password form. Completing it signs out every other session.

**Blocked by:** 01.

- [ ] Public request endpoint takes email or username, always answers success, does the same work on both branches, and sends mail only for a verified address. Reset tokens expire after one hour.
- [ ] Public complete endpoint takes token plus new password, applies the change-password rules, bumps `token_version`, and marks the token consumed.
- [ ] Per-IP and per-email limiters on the request endpoint, in memory.
- [ ] Links point at the site's `/reset-password` page with the raw token in the query.
- [ ] Route tests cover: verified, unverified, and unknown accounts answer identically; mail captured only for verified; completion ends an existing session; expired and consumed tokens rejected; limiter trips.
