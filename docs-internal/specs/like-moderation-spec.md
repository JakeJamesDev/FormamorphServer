# Spec: Like moderation

Status: ready-for-agent

## Problem Statement

Some listings are climbing the catalog on likes that do not come from real readers. Staff suspect that a few people register throwaway accounts and like their own work from each one. Today staff see only the like count. They cannot see which accounts liked a listing, how old those accounts are, or what else those accounts have liked. Without that, there is no way to tell a popular listing from an inflated one, and no way to undo the inflation short of deleting accounts.

## Solution

Staff get two read views and two removal actions, all behind the staff gate.

- **Who liked this listing.** A staff-only list of every account that liked a listing, newest like first, with the account's creation date, its status, and how old it was when it liked. Each row carries the account id, so the client can open the existing public profile from the name.
- **What this account liked.** A staff-only list of every listing an account has liked, newest first, with each listing's author. One account liking a whole cluster from one author shows up at a glance.
- **Remove one like.** Staff take a single like off a listing. The public count drops at once.
- **Clear an account's likes.** Staff remove every like one account has given, in one action.

Both removals respect the staff ladder and land in the audit log. Suspension semantics do not change: a suspended account already cannot like, and an unsuspended one can like again, including a listing whose like was removed.

## User Stories

1. As a staff member, I want to see every account that liked a listing, so that I can judge whether its count is real.
2. As a staff member, I want each liker's account creation date, so that I can spot accounts made just before they liked.
3. As a staff member, I want each liker's account age at the moment it liked, so that I can sort or flag rows without doing date math.
4. As a staff member, I want each liker's account status, so that I can see which rows I have already acted on.
5. As a staff member, I want each liker's id and username, so that the client can open their profile from the name.
6. As a staff member, I want each liker's avatar, so that the list reads like the rest of the moderation tools.
7. As a staff member, I want likers ordered newest like first, so that a fresh burst sits at the top.
8. As a staff member, I want the full like count alongside the rows, so that I can tell when the list was cut at the cap.
9. As a staff member, I want to see likers of a quarantined listing, so that hiding a listing does not hide the evidence.
10. As a staff member, I want every listing one account has liked, so that I can see whether it only ever likes one author's work.
11. As a staff member, I want each liked listing's author id and username, so that a cluster around one author is obvious.
12. As a staff member, I want each liked listing's name, so that I can recognize it without opening it.
13. As a staff member, I want a quarantined flag on each liked listing, so that a like on a hidden listing is marked rather than dropped.
14. As a staff member, I want the like time on each liked listing, so that I can see a batch given in one sitting.
15. As a staff member, I want to remove one like from a listing, so that a single fake like stops counting.
16. As a staff member, I want to clear every like one account has given, so that a throwaway account's whole footprint goes in one action.
17. As a staff member, I want the public like count to drop the moment I remove a like, so that the catalog reflects the correction at once.
18. As a staff member, I want each removal recorded in the audit log, so that the team can see who corrected what.
19. As a staff member, I want a bulk clear recorded as one audit entry with the count, so that the log stays readable.
20. As a mod, I want to be refused when I try to remove another staff member's like, so that staff moderate the room and not each other.
21. As an admin, I want to reach a mod's or dev's like but not another admin's, so that the ladder matches every other moderation action.
22. As a listing author, I want my like count to stay a count and nothing more, so that who liked my work stays private.
23. As an ordinary reader, I want to be refused when I ask who liked a listing, so that likes stay a private choice.
24. As a signed-out visitor, I want to be refused when I ask who liked a listing, so that the list is never scraped.
25. As a suspended account, I want to be refused when I try to like, so that suspension means what it says.
26. As a reinstated account, I want to like a listing again even if staff removed my earlier like, so that a past correction does not follow me forever.
27. As a staff member, I want a missing listing or account to answer not found, so that a stale link fails cleanly.
28. As a staff member, I want the liker list to stop at a cap, so that one viral listing cannot turn the endpoint into a table dump.

## Implementation Decisions

**Vocabulary.** A *like* is one account's revocable mark on a listing. A *liker* is the account behind one like. *Staff* and the *staff ladder* are as defined in the domain glossary.

**Routes.** Four new routes, all behind the sign-in and staff gates, alongside the existing like route.

- `GET /api/worlds/:id/likes` lists likers of a listing.
- `GET /api/users/:id/likes` lists likes given by an account.
- `DELETE /api/worlds/:id/likes/:userId` removes one like.
- `DELETE /api/users/:id/likes` clears every like an account has given.

**Liker row.** `id`, `username`, `avatarUrl`, `status`, `createdAt` (account), `likedAt`, and `accountAgeAtLikeSeconds`. Age is in seconds because both timestamps are second resolution. No email: the staff user list already carries it.

**Liked listing row.** `id`, `name`, `authorId`, `authorUsername`, `quarantined`, and `likedAt`.

**List shape.** Both reads return `{ total, rows }` under `data`. `total` is the full count. `rows` is at most 500, newest like first, ties broken by the other key so order is stable. No paging.

**Visibility.** Reads use the listing as stored, not the viewer-filtered form: a quarantined listing still answers to staff. A missing listing or account is not found.

**Staff ladder.** Both removals check the actor against the liker with the shared moderation rule. A refusal uses the one shared wording so a probe cannot tell the cases apart. Clearing an account's likes checks once, against that account.

**Idempotence.** Removing a like that is not there succeeds with nothing to do, matching the existing set-like behavior. Clearing an account with no likes succeeds with a count of zero.

**Audit log.** Two new actions join the fixed action list: `like_removed` and `likes_cleared`. Both snapshot the actor and the liker as target. A single removal names the listing. A bulk clear carries the number removed in the snippet. Reads are not logged.

**Public count.** The listing's like count is computed per query, so a removal is visible on the next read with no cache to clear.

**Model surface.** The listing model gains a likers query, a likes-given query, a single-like removal, and a per-account clear that returns how many rows went. The existing set-like, count, and has-liked methods do not change.

**Suspension.** No change. The sign-in gate already refuses every non-read request from a suspended account, which covers liking. A removed like is a deleted row, so a reinstated account can like the same listing again.

## Testing Decisions

**One seam: HTTP.** Every test drives the Express app through supertest, seeds accounts and listings with the shared helpers, and asserts on responses. No model method is called directly. The audit log is checked through its own read route, the same way the existing audit tests do.

**What a good test looks like here.** It exercises one story from the list above through the routes a client would use, then asserts the visible outcome: the rows returned, the status code, the public count on the listing, or the audit entry. It never inspects the database to prove a behavior the API can already show.

**Coverage to write.**

- Staff see likers with every field, newest first, with `total`. Ordinary readers, the listing author, and signed-out visitors are refused.
- Age at like is computed from a seeded account creation date and a like made later.
- Liker list of a quarantined listing still answers to staff.
- Likes-given list carries the listing, its author, the quarantined flag, and the like time, newest first.
- Cap: seeded likes beyond the cap yield exactly the cap in rows and the true `total`.
- Single removal drops the public count, is idempotent, and lands as `like_removed`.
- Bulk clear removes every like, reports the count, is idempotent, and lands as one `likes_cleared` entry with the count.
- Ladder: a mod is refused on a mod's, dev's, or admin's like with the shared wording. An admin reaches a mod and a dev but not an admin.
- Reinstated account likes again after removal.
- Missing listing and missing account are not found.

**Prior art.** The existing likes tests for seeding and the like route. The admin user tests for the staff gate and the status field. The roles tests for ladder refusals. The audit tests for reading entries back through the API. The follows tests for the pattern of seeding an account at a chosen creation date.

**Bar.** Coverage is measured, not guessed. Each guard test is checked to fail when its guard is removed. No scenario is shaped so a mechanic cannot fire.

## Out of Scope

- Paging on either list.
- Logging reads of either list.
- Excluding suspended accounts' likes from the public count or catalog sort.
- Bulk removal of several likes on one listing by a list of ids.
- Any client work. The existing public profile route already serves the click-through.
- Automatic detection or flagging of suspect clusters. The data is exposed; the judgment stays with staff.

## Further Notes

The domain glossary should gain a **Like** entry alongside Comment, and **Audit log** should mention the two new actions.
