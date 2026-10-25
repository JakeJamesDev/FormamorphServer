# Spec: Listing review

Status: ready-for-agent

Client side: the formamorph repo, `docs-internal/specs/listing-review/spec.md`.

## Problem Statement

Today a published listing is public the moment the author publishes it. Staff find rule-breaking content only after players can already see it, then quarantine it. Until a mod gets to it, every player can open, download, like and follow it. An update to a clean listing has the same gap: an author can publish clean content, then replace it with content that breaks the rules, and the replacement goes live at once.

## Solution

Review comes before visibility. When review is on, a new listing is **pending** and only its author and staff can see it. A mod approves it, and then it goes live. A mod rejects it, and then it enters the existing quarantine.

An edit to an approved listing becomes a **pending update**. The approved version stays live, unchanged, until a mod approves the update. A rejected update is dropped, and the approved version stays.

Staff uploads and uploads from **trusted authors** skip review. Admins grant and revoke trust. Every skip is recorded so mods can spot-check it. Admins can turn review on and off with a server setting.

## Rulings

From the grill on 2026-10-25 (Q1–Q22) and the follow-up after the code review (Q23–Q28). A ruling reopens on new evidence only.

- **Q1** All five listing kinds go through review.
- **Q2** Comments and profile text stay outside review. They keep using reports.
- **Q3** An update to an approved listing goes to review. The approved version stays live while the update waits.
- **Q4** Unlisted listings go through review too.
- **Q5** Staff can mark an author as trusted. A trusted author's uploads skip review.
- **Q6** A rejected new listing enters the existing quarantine.
- **Q7** Every listing that exists at deploy counts as approved.
- **Q8** A pending listing can enter a contest. Its submission time counts against the contest deadline.
- **Q9** Every field an author can edit waits in the pending update.
- **Q10** A rejected update is dropped. The approved version stays live.
- **Q11** A new edit to a pending item replaces it and keeps its place in the queue.
- **Q12** Trusted authors skip review for updates too.
- **Q13** Staff (mod, dev, admin) count as trusted without a grant.
- **Q14** The queue shows contest entries first, then oldest first.
- **Q15** Approval sends no message.
- **Q16** Admins have a server setting that turns review on and off.
- **Q17** Turning review off leaves pending items in the queue. Only new submissions skip review.
- **Q18** Rejection reuses quarantine as it is. No new reason or category field.
- **Q19** An author edit to a rejected listing sends it back to the queue. The quarantine deadline keeps running.
- **Q20** Only admins grant and revoke trust.
- **Q21** Mods get a list of recent auto-approvals to spot-check.
- **Q22** A rejection is followed by the client's message flow to the author.
- **Q23** A resubmitted rejected listing gets the same one-time extension as any quarantined listing on its author's first edit.
- **Q24** Rejecting a resubmission keeps the existing deadline. It never starts a new one.
- **Q25** Dependencies, compatibility, the spoiler flag and changelog entries wait for review like every other edit.
- **Q26** During contest judging, approval of an update to a contest entry waits until results are announced.
- **Q27** After a mod rejects an update, the message composer opens at once, as it does after a quarantine.
- **Q28** The state is named `moderation_state`. "Review state" stays the add-on offer term.

Answered for ticket 01:

- **T1** Any `moderation_state` other than `approved` is hidden from players.
- **T2** Report filing answers `404` to a player only for `pending` and `rejected` listings. Quarantined and unlisted listings stay reportable, as today.
- **T3** The existing `sort=created_at` key reads `listed_at`. There is no new sort key, so old clients get the new order.
- **T4** `listing_auto_approved` is written only while review is on.
- **T5** The author and staff can comment on a pending listing. Players cannot reach it.
- **T6** `listed_at` stays in player payloads. The podium refuses a non-approved entry with `409`, as it does for quarantine.

Answered for ticket 04:

- **T7** `trustedAt` (ISO or null) shows on the staff user list only. It is not on `getMe` or the public profile.
- **T8** Trust on the `[deleted user]` row answers `403`. Trust on a staff account or a suspended account is allowed, because the column outlives a demotion.
- **T9** Trust writes are idempotent. A repeated grant keeps the first `trusted_at`, and a no-op writes no audit entry.
- **T10** The trust routes answer `{ success, user: { id, username, trustedAt } }`.
- **T11** `GET /api/reviews/auto` pages like the audit list (default 20, cap 100) and answers `{ entries, total }`. Each entry comes from the audit snapshot: `{ id, targetId, targetKind, targetName, actor: { id, username, role }, createdAt }`. It does not join the live listing.
- **T12** The actor's recorded role says why a listing skipped review. There is no extra field.

Answered for ticket 07 (the contract ticket 05 serves):

- **T13** `pending_update` has this shape: `{ fields: { <name>: { approved, pending } }, changelog: [...ops], content_changed: boolean, thumbnail_url?: string }`.
- **T14** `GET /api/reviews/meta` needs no sign-in. The client caches the answer once per session.

## User Stories

1. As a player, I want to see only listings a mod approved, so that I never open content that breaks the rules.
2. As a player, I want a listing I already use to stay available while its author's update waits, so that review never takes away something I play.
3. As a player, I want an approved listing's name, thumbnail, description, links and changelog to stay as approved until an update is approved, so that rule-breaking text or images never show.
4. As a player, I want a pending listing to answer `404` to me everywhere, so that I cannot tell it exists.
5. As a player, I want dependency resolution and add-on offers to skip a pending listing, so that an approved world never pulls unreviewed content to me.
6. As a player, I want my follows feed to show a listing when it is approved, so that a late approval still reaches me.
7. As a player, I want a newly approved listing to sort as new in the catalog, so that review time does not bury it.
8. As an author, I want my new listing saved and visible to me while it waits, so that I can check it and keep working on it.
9. As an author, I want my listing to show that it is pending review, so that I know why players cannot see it yet.
10. As an author, I want to edit a pending listing without losing my place in the queue, so that a typo fix does not cost me time.
11. As an author, I want to see my pending update beside the approved version, so that I know what players see now and what will replace it.
12. As an author, I want my changelog entries, dependencies and compatibility edits to join my pending update, so that one review covers the whole change.
13. As an author, I want to edit my pending update again before review, so that the mod reviews my latest work.
14. As an author, I want my approved listing to keep its likes, comments and followers while an update waits, so that an update never resets my listing.
15. As an author, I want to fix a rejected listing and send it back to review, so that one rejection does not force me to start over.
16. As an author, I want my first fix to a rejected listing to extend the deadline once, so that a fix on the last day is not deleted the next day.
17. As an author, I want to enter a contest with a pending listing, so that slow review never costs me a contest slot.
18. As an author, I want my contest entry to count from when I submitted it, so that review after the deadline does not disqualify me.
19. As an author, I want to delete my pending listing, so that I can withdraw it.
20. As an author, I want to discard my pending update, so that I can withdraw an edit I regret.
21. As a trusted author, I want my uploads and updates to go live at once, so that a good record saves me the wait.
22. As a mod, I want one queue of everything waiting for review, so that nothing slips through.
23. As a mod, I want contest entries at the top of the queue, then the oldest items, so that urgent items come first and no author waits longest.
24. As a mod, I want each queue item to say whether it is a new listing, an update or a resubmission, so that I know what to check.
25. As a mod, I want an update to show which fields changed and both values, so that I review only what changed.
26. As a mod, I want to download the pending content and see the pending thumbnail, so that I check the real files.
27. As a mod, I want to approve an item with one action, so that clean content goes live quickly.
28. As a mod, I want to reject a new listing into quarantine with a length I pick, so that the author gets the usual time to fix it.
29. As a mod, I want rejecting a resubmission to keep its deadline, so that resubmitting never buys unlimited time.
30. As a mod, I want to reject an update and keep the approved version live, so that one bad edit does not remove a good listing.
31. As a mod, I want approving an update to a judged contest entry to wait for results, so that judges see the work as it stood at the deadline.
32. As a mod, I want a staff member's own uploads to skip the queue, so that staff never approve their own work.
33. As a mod, I want a list of recent auto-approvals that links to each listing, so that I can spot-check trusted and staff uploads.
34. As a mod, I want every approval, rejection and auto-approval in the audit log, so that review decisions are on record.
35. As a mod, I want an approval or rejection to fail clearly when another mod already handled the item, so that two mods never act on one item twice.
36. As a mod, I want the queue count without loading the whole queue, so that the client can show it.
37. As a mod, I want the staff ladder to apply to review, so that a mod cannot reject an admin's listing.
38. As a mod, I want releasing a rejected listing from quarantine to approve it, so that a release never leaves a listing outside every list.
39. As an admin, I want to grant and revoke trust, so that trust follows an author's conduct.
40. As an admin, I want trust changes in the audit log, so that they are on record.
41. As an admin, I want to be the only one who can turn review on and off, so that a single mod cannot disable it.
42. As an admin, I want items already pending to stay pending when I turn review off, so that nothing unreviewed goes live because of a setting change.
43. As an admin, I want every existing listing to count as approved at deploy, so that launch starts with an empty queue.
44. As the operator, I want review off until the client that shows it is released, so that an old client never publishes into a state it cannot show.
45. As the operator, I want backups to include pending files, so that a restore does not lose work waiting for review.

## Implementation Decisions

### Moderation state on a listing

- A schema step adds three columns to `worlds`:
  - `moderation_state`, which is `approved`, `pending` or `rejected`. The step backfills `approved` (Q7).
  - `moderation_queued_at`, which sets the item's place in the queue. A re-edit leaves it unchanged (Q11).
  - `listed_at`, the time the listing first went live. The step backfills it from `created_at`.
- `created_at` keeps meaning submission time. The catalog's "newest" sort moves to `listed_at`, so a late approval sorts as new.
- `pending` and `rejected` follow the quarantine visibility rule: only the author and staff see the listing. Every read path applies it:
  - `World.isVisibleTo`, which `isDependencyVisibleTo` calls, so dependency resolution is covered.
  - The WHERE clause in `World.getAll`. It builds its own SQL and serves the catalog, `/users/:id/worlds` and `/me/worlds`.
  - The raw SQL in the follows feed, the unread count and the author totals.
  - `Compatibility.worldsFor`, which must select `moderation_state` so the add-on check sees it.
  - `readPodium`, which accepts only `approved` entries.
  - Report filing, which answers `404` for a target the reporter cannot see.
- The fields `moderation_state`, `moderation_queued_at`, `has_pending_update` and `pending_update` are removed from listing payloads for anyone who is neither the author nor staff. `SELECT w.*` and `findByIdWithAuthor` send every column today, so the strip has to happen where the payload is built.

### Pending updates

- A new table holds pending updates, one row per listing at most. It holds:
  - the changed listing fields, as JSON;
  - dependency, compatibility and spoiler changes;
  - changelog operations in order (Q25);
  - the pending content file name and thumbnail file name;
  - `submitted_at` and `queued_at`.
- Pending files live in their own folder, apart from the public worlds and thumbnails folders. Content is overwritten in place as `${worldId}.json`, and the thumbnail gets a new name on each update. So pending files need their own names, or approval and rejection could delete live files.
- On an approved listing, these writes go to the pending update and create it if it does not exist: the main update, the dependencies route, the compatibility route, the spoiler route, and the changelog create, edit and delete routes. The visibility, dependency and compatibility writes inside `updateWorld` go there too. An author or staff member who skips review writes at once, as today.
- On a `pending` or `rejected` listing, every write changes the listing in place, because the listing is hidden.
- Approval applies everything in one transaction, the same way the writes apply today. The fields change, the files replace the live files, `revision` goes up once, and `updated_at` becomes now. Then the pending row and the pending files are deleted.
- Rejection deletes the pending row and its files (Q10).
- Pending files are deleted on all three listing delete paths: `deleteWorld`, `sweepQuarantine` and `eraseUser`. Backup and restore include the pending folder.
- The author and staff get `has_pending_update` on list rows and `pending_update` on the single read. `pending_update` holds the changed fields, the changelog operations, and whether content changed. A pending thumbnail has an `/api/reviews/:id/thumbnail` URL. The public thumbnails route has no access check, so it never serves a pending thumbnail.

### Submission paths

| Who submits | Review on | Review off |
| --- | --- | --- |
| Normal author, new listing | `pending`, enters the queue | `approved`, `listed_at` now |
| Normal author, edit to an approved listing | pending update, enters the queue | applied at once |
| Trusted author or staff | `approved` or applied at once, audit `listing_auto_approved` | same as review off |

### Rejection and quarantine

- **Rejecting a new listing:** `moderation_state` becomes `rejected`, and `World.quarantine` runs with the chosen `days`. The days follow the same rules and limits as the quarantine route (Q6, Q18).
- **Author edit to a `rejected` listing:**
  - The state goes back to `pending` with a new `moderation_queued_at` (Q19).
  - The existing quarantine edit path runs unchanged. It grants the one-time extension and writes `quarantine_updated` (Q23).
- **Rejecting a resubmission:** the state becomes `rejected` and the quarantine stays as it is. `World.quarantine` is not called, so the deadline and the extension flag stay (Q24). The route ignores `days`.
- **Approving a `pending` listing that is quarantined:** approval releases the quarantine and clears all three quarantine columns.
- **Staff releasing a `rejected` listing** through `DELETE /:id/quarantine`: the release approves it. The state becomes `approved`, `listed_at` is set, and the audit records `listing_approved`. No listing is left outside the queue and the catalog.
- **Quarantining an approved listing:** this works as today. Edits to it become a pending update, and approving that update does not release the quarantine.

### Review routes

All review routes use the `canModerate` gate, including the staff ladder against the author. `:id` is always the listing id. A listing has either a pending state or a pending update, never both.

- `GET /api/reviews/meta`: open to everyone, `{ enabled }`. The client detects the feature from it, the same way it detects reports.
- `GET /api/reviews`: the queue, contest entries first, then oldest `queued_at` first (Q14). Each item carries:
  - the listing id, kind, name and author;
  - its type: `new`, `update` or `resubmitted`;
  - the contest it entered;
  - for an update, the changed fields with their approved and pending values, and the changelog operations;
  - for a resubmission, the quarantine deadline.
- `GET /api/reviews/count`: the number of waiting items.
- `GET /api/reviews/:id/content` and `GET /api/reviews/:id/thumbnail`: the pending files. The author can read them too.
- `POST /api/reviews/:id/approve`.
  - During judging, approving an update to a contest entry answers `409` and the item stays in the queue (Q26). Approving a new contest entry during judging is allowed (Q8).
- `POST /api/reviews/:id/reject`: the body takes `days` for a new listing.
  - For a new listing or a resubmission, the answer includes the author and the quarantine fields, `quarantined_at` and `quarantine_expires_at`. The client's message template needs them.
  - For an update, the answer includes the author.
- `DELETE /api/reviews/:id`: the author discards a pending update.
- Approve and reject answer `409` when the item is no longer waiting.
- `GET /api/reviews/auto`: recent auto-approvals, newest first (Q21).
- The audit log gets a nullable `target_id` column. The new actions write it, so the auto-approval list can link to each listing.
- Audit actions: `listing_approved`, `listing_rejected`, `update_approved`, `update_rejected`, `listing_auto_approved`, `author_trusted`, `author_untrusted`.

### Trust

- `users` gets a `trusted_at` column. Null means not trusted.
- `PUT /api/users/:id/trust` and `DELETE /api/users/:id/trust` are admin-only (Q20).
- Staff roles count as trusted without the column (Q13).
- These reads must include `trusted_at`: the queries that load `req.user` in the auth middleware, `User.findById`, and the staff user list. It does not show on the public profile.

### Setting

- A new setting `listing_review`, a boolean, defaults to `false` (story 44).
- The settings routes allow any staff member to write today. The settings config gains a per-key `adminOnly` flag, and `listing_review` sets it (Q16).
- Turning review off changes only new submissions (Q17).

### Contests

- A pending listing can enter a contest. The entry check runs at submission, against the contest that is active then (Q8).
- A pending or rejected entry counts toward the one-entry-per-person rule, as a quarantined one does today.
- A pending entry gets no likes, because the like routes refuse listings the viewer cannot see.

### Glossary

Add to `CONTEXT.md`: **Moderation state**, **Pending listing**, **Pending update**, **Resubmission**, **Trusted author**, **Auto-approval**. Keep **Review state** for add-on offers, and point the new terms at it so the two are not confused.

## Testing Decisions

- One seam: the HTTP API through supertest, as in `quarantine.test.js`. Tests read what a player, an author and a mod each get back. They never read columns.
- A new `listingReview.test.js` covers these cases:
  - **Visibility:** a pending listing is invisible on every read path named above. That includes the catalog through `getAll`, add-on offers, the podium and report filing.
  - **Payloads:** moderation fields never reach a player.
  - **Pending updates:** the approved version stays live until approval, including dependency, compatibility, spoiler and changelog edits. Approval applies everything and moves `updated_at` and the follows feed. A rejected update leaves the approved version and every live file untouched.
  - **Thumbnails:** the public thumbnails route never serves a pending thumbnail.
  - **Queue place:** a re-edit keeps the item's place.
  - **Resubmission:** an edit to a rejected listing returns it to the queue and grants the extension once. Rejecting the resubmission keeps the deadline. Approving it releases the quarantine. A staff release of a rejected listing approves it.
  - **Skipping review:** trusted and staff uploads skip the queue and write an audit entry with `target_id`.
  - **Setting:** it is off by default, a mod cannot write it, and turning it off leaves the queue unchanged.
  - **Contests:** contest entries sort first. A pending entry holds the author's one contest slot. Approving an update during judging answers `409`.
  - **Races and permissions:** a second approval answers `409`, the staff ladder refuses a mod on an admin's listing, and a mod's trust grant is refused.
  - **Deletes:** each delete path removes the pending files.
- Each visibility guard must fail when its filter is removed. Prove one per read path by reverting the filter once.
- Prior art: `quarantine.test.js`, `contestEntries.test.js`, `follows.test.js`, `privacyGate.test.js`, `reports.test.js`, `linkedContent.test.js`, `changelog.test.js`.

## Out of Scope

- Review of comments and profile text (Q2).
- Rejection reasons or categories (Q18).
- Automatic trust from an author's history (Q5).
- Review of existing listings (Q7).
- Any change to world or save export shape. All new fields live on the server.

## Further Notes

- The client spec holds every UI decision, including the message flow after a rejection (Q22, Q27).
- A deploy with the setting off changes nothing for players, so the server can deploy before the client ships.
