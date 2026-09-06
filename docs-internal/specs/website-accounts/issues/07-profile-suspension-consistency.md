# 07 — Hide suspended profiles publicly and preserve admin access

Status: ready-for-human
Spec: [website accounts](../spec.md)

**What to build:** Hide suspended profiles from public view through both UUID and username lookups, while preserving authenticated admin access for moderation. This approved follow-up changes the UUID behavior preserved by [05](05-public-profile-by-username.md).

**Decision — September 6, 2026:** Suspended profiles must be hidden publicly. Admins must still be able to see them. Inspect the existing admin routes and consumers before choosing where to preserve that access; an ordinary signed-in session must not bypass public hiding.

## Evidence

Before this ticket, the [profile controller](../../../../src/controllers/userController.js) hid suspended accounts on the username route while the UUID route checked only existence. Comparing both routes could therefore distinguish suspension from an unknown name when the UUID was known.

## Done when

- [x] Align public visibility while preserving admin access.
- [x] Return the same not-found response for suspended and unknown accounts through public UUID and username lookups; retain normal-profile behavior.
- [x] Preserve authenticated admin access to suspended accounts through the moderation interface.
- [x] Add route-level regression coverage for public hiding, ordinary signed-in callers, and permitted admin access; verify affected consumers.
- [x] Update the relevant ticket/spec claims to match the decision.

## Comments

Implemented September 6, 2026. `GET /api/users/:id/profile` now gives a suspended row the same 404 response as an unknown id. `optionalAuth` still supplies follow state for visible profiles, but an ordinary signed-in caller does not bypass either public refusal.

Admin access stays on `GET /api/users`, the route already used by the Manage Users moderation table. Its response includes suspended accounts and their status; the public profile routes do not gain an admin exception. No production server consumer calls either public profile route internally.
