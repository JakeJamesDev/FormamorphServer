# 07 — Hide suspended profiles publicly and preserve admin access

Status: ready-for-agent
Spec: [website accounts](../spec.md)

**What to build:** Hide suspended profiles from public view through both UUID and username lookups, while preserving authenticated admin access for moderation. This approved follow-up changes the UUID behavior preserved by [05](05-public-profile-by-username.md).

**Decision — September 6, 2026:** Suspended profiles must be hidden publicly. Admins must still be able to see them. Inspect the existing admin routes and consumers before choosing where to preserve that access; an ordinary signed-in session must not bypass public hiding.

## Evidence

In the [profile controller](../../../../src/controllers/userController.js), the username route hides suspended accounts; the UUID route only checks existence. The [UUID profile test](../../../../tests/userProfile.test.js) deliberately reads a suspended account's DTO. Comparing both routes can therefore distinguish suspension from an unknown name when the UUID is known.

## Done when

- [x] Align public visibility while preserving admin access.
- [ ] Return the same not-found response for suspended and unknown accounts through public UUID and username lookups; retain normal-profile behavior.
- [ ] Preserve authenticated admin access to suspended accounts through the moderation interface.
- [ ] Add route-level regression coverage for public hiding, ordinary signed-in callers, and permitted admin access; verify affected consumers.
- [ ] Update the relevant ticket/spec claims to match the decision.

Reconciled September 6, 2026. No endpoint behavior changed during this inventory.
