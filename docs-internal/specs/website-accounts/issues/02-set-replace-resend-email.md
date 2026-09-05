# 02 — Set, replace, and resend email

Status: ready-for-agent
Spec: ../spec.md

**What to build:** A signed-in player sets or replaces their email and gets a fresh verification mail. A player who lost the mail asks for it again. Abuse of these endpoints is bounded without storing an IP.

**Blocked by:** 01.

- [ ] Authenticated set-email endpoint writes the address, clears the verified stamp, invalidates earlier verify tokens, sends verification. A taken address returns the conflict error.
- [ ] Authenticated resend endpoint sends again only while unverified.
- [ ] Both sit behind the auth limiter plus per-IP and per-email limiters using the existing express-rate-limit dependency in memory. Nothing persisted or logged.
- [ ] Route tests cover: set, replace clears verified, resend, resend after verified is a no-op, limiter trips.
