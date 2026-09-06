# 02 — Set, replace, and resend email

Status: ready-for-human
Spec: [website accounts](../spec.md)

**What to build:** A signed-in player sets or replaces their email and gets a fresh verification mail. A player who lost the mail asks for it again. Abuse of these endpoints is bounded without storing an IP.

**Dependencies:** [01](01-register-with-email-and-verify.md), implemented. Human review remains.

- [x] Authenticated set-email endpoint replaces a changed address, clears its verified stamp, invalidates earlier verify tokens, and sends verification. A case-insensitively unchanged address preserves verification. A taken address returns the conflict error.
- [x] Authenticated resend endpoint sends again only while unverified.
- [x] Both use the existing per-IP auth limiter and a shared per-account mail limiter (five per hour), using express-rate-limit in memory. Limiter keys are not persisted or logged; failed requests are refunded.
- [x] Route tests cover: set, replace clears verified, resend, resend after verified is a no-op, limiter trips.

## Comments

Implemented in `c245781`; reconciled September 6, 2026. The account-keyed five-per-hour mail budget was approved on September 6, 2026. The checked criteria describe the code; unchanged-address behavior and the `mailSent` addition remain documented implementation details for review.

Built as `POST /api/auth/email` and `POST /api/auth/resend-verification`, both under `protect`.

**The per-IP limiter is the existing `authLimiter`.** The checkbox names "the auth limiter plus per-IP
and per-email limiters", which reads as three. `authLimiter` is already keyed on the client IP, so both
routes carry a per-IP limit and a second one. Nothing was added for the third name.

**The second limiter is keyed on the account, not the address the request names.** The spec asks for a
per-email key. Written that way, anyone could drain a stranger's budget by repeatedly trying to claim
their address: each attempt is refused with `EMAIL_TAKEN`, and the holder's own resend then answers 429.
An address can only be mailed by the one account holding it, so bounding the account already bounds the
inbox, and no stranger's address sits in the limiter's memory. Refusals are refunded, so a mistyped
address costs nothing. Five per hour. **Ticket 03 should not copy the account key**: a reset request is
unauthenticated, so it has no account to key on, and its per-address key needs its own answer to this.

**Setting the address already on file keeps the verified stamp.** The checkbox says a set "writes the
address, clears the verified stamp". Taken flatly, opening the account page and pressing Save would undo
a verification the player had already done. A resave, folded for case, is treated as no change.

**Both routes answer `mailSent`.** Not asked for. Delivery is Resend's job, and a route whose whole
purpose is to send a mail has to say whether it did, so the client can offer another try. Register keeps
its old shape and still swallows the outcome.

Release follow-ups: [privacy policy](06-update-email-privacy-policy.md) and the [production duplicate-address preflight](04-deploy-mail-to-the-box.md).
