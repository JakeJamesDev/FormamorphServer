# 05 — Public profile by username

Status: ready-for-agent
Spec: ../spec.md
Client twin: `formamorph/docs-internal/specs/website-accounts/issues/04-public-profile.md`

**What to build:** The site's shareable profile link is `formamorph.ai/u/<username>`, so the site holds a name where every profile endpoint takes a UUID. One public endpoint resolves a name to the same profile DTO, and answers a suspended account the way it answers a name nobody has.

**Blocked by:** None — can start immediately.

**Why the existing route cannot do it:** `GET /api/users/:id/profile` reads `User.findById`, so a username misses and 404s. The DTO carries no `status`, so a client cannot tell a suspended account from an ordinary one either. The client ticket is blocked on both.

- [ ] `GET /api/users/by-username/:username/profile`, `optionalAuth`, returning the same DTO `getUserProfile` builds — id included, so the caller reads creations from the existing `/users/:id/worlds`.
- [ ] The lookup is case-insensitive, matching the registration uniqueness rule.
- [ ] A suspended account answers 404 with the same body an unknown name gets. Suspension must not be distinguishable from absence.
- [ ] Mounted above the `/:id` routes, so a username is never read as an id.
- [ ] The existing `/:id/profile` is left as it is. The in-app dialog opens profiles by id and its behavior does not change here.
- [ ] Route tests: a known name resolves, a differently-cased name resolves, an unknown name 404s, a suspended account 404s with a body identical to the unknown one, and a signed-in caller still gets `following`.

## Comments
