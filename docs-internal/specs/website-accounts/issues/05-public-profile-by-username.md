# 05 — Public profile by username

Status: ready-for-human
Spec: [website accounts](../spec.md)
Client twin: [public profile](../../../../../formamorph/docs-internal/specs/website-accounts/issues/04-public-profile.md)

**What to build:** The site's shareable profile link is `formamorph.ai/u/<username>`, so the site holds a name where every profile endpoint takes a UUID. One public endpoint resolves a name to the same profile DTO, and answers a suspended account the way it answers a name nobody has.

**Dependencies:** None. Implemented in `36bd871`; human review and deployed client integration remain.

**Why the existing route cannot do it:** `GET /api/users/:id/profile` reads `User.findById`, so a username misses and 404s. The DTO carries no `status`, so a client cannot tell a suspended account from an ordinary one either. The client ticket is blocked on both.

- [x] `GET /api/users/by-username/:username/profile`, `optionalAuth`, returning the same DTO `getUserProfile` builds — id included, so the caller reads creations from the existing `/users/:id/worlds`.
- [x] Exact spelling selects its owner; otherwise a case-insensitive lookup selects the oldest visible account. Registration still permits differently cased names. Ownership rules approved September 6, 2026; see [08](08-username-case-ownership.md).
- [x] A suspended account answers 404 with the same body an unknown name gets. Suspension must not be distinguishable from absence.
- [x] Mounted above the `/:id` routes, so a username is never read as an id.
- [x] Both lookup routes use the same profile DTO. [Ticket 07](07-profile-suspension-consistency.md) now hides suspended profiles through the UUID route too.
- [x] Route tests: a known name resolves, a differently-cased name resolves, an unknown name 404s, a suspended account 404s with a body identical to the unknown one, and a signed-in caller still gets `following`.

## Comments

Reconciled September 6, 2026. The endpoint now exists locally. The client twin's statement that the endpoint is unimplemented is stale; production availability remains unverified. [Ticket 04](04-deploy-mail-to-the-box.md) owns the live integration check. [Ticket 08](08-username-case-ownership.md) records the separate username-ownership decision.

**The ticket's premise about case is wrong, and the fix is shaped around that.** "Matching the
registration uniqueness rule" assumes names are already compared case-insensitively. They are not:
`username TEXT UNIQUE NOT NULL` in `src/schema/tables.js` compares byte for byte and no NOCASE index
exists, so `wren` and `Wren` are two accounts that can both register today. A plain folded lookup would
therefore hand two creators one link. The pick is in two parts instead. A name asked for byte for byte
reaches the account that holds it, shown or refused on its own status — so spelling a suspended name
differently is not a way around it. A spelling nobody holds reaches the oldest account still shown.
Making registration itself case-insensitive needs a migration and a policy for whichever collisions the
live table already holds; that is its own ticket, not this one.

**The shadowing bug the review caught.** The first cut looked the name up, then filtered status. With a
suspended `Wren` older than a live `wren`, every casing but the exact one landed on the suspended row
and 404'd — a live creator's link broken by a namesake, and a 404/200 split across casings that itself
said something had been acted on. The status filter now runs inside the pick. Proven by seeding exactly
that pair; reverting the filter turns the test red.

**Two tests were passing by luck before the mutation checks.** Accounts seeded in one second tie on
`created_at` and settle on a random UUID, so the namesake test flipped with the id draw. Both fixtures
now carry explicit dates, and the oldest-wins test seeds the newer account first — otherwise a plain
scan returns insertion order and passes without the `ORDER BY` doing anything.

**Deliberately wider than asked.** Three things the ticket did not request. `idx_users_username_nocase`,
without which the folded match is a table scan. A 404 for the reserved `[deleted user]` row, which owns
departed creators' leftover work and is not a person to show. And the DTO moved into one `publicProfile`
helper both routes call — that touches the handler the ticket said to leave alone, so the test asserts
the two routes answer with `toEqual` rather than trusting the refactor.

**A decision, not an implementation detail:** oldest wins when two casings collide, so who owns
`/u/<name>` does not move when a newer account picks up another spelling. Say so if a different rule is
wanted.

**Follow-up fixed:** [Ticket 07](07-profile-suspension-consistency.md) now makes `GET /:id/profile` answer
the same 404 for a suspended account as for an unknown id. Admins continue to see suspended accounts
through the separate Manage Users moderation route.
