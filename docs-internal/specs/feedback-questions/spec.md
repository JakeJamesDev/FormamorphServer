# Spec: Feedback Questions (server)

Status: ready-for-agent

Client side: the formamorph repo, `docs-internal/specs/feedback-questions/spec.md`. This spec holds the rulings (Q1–Q24) and the API contract. The client spec follows them.

## Problem Statement

Players who are stuck have no place to ask. Any signed-in account can read every feedback thread, but a bug report is a fault report: only its reporter and staff may reply. A suggestion is open to replies, but it is a request for a change, not a question. So a player files a misfiled bug, asks somewhere staff do not read, or gives up. When many players have the same question, nothing shows how many, and an answer given once is hard for the next player to find.

## Solution

Feedback gets a third type, **question**, beside bug and suggestion. A question works like a suggestion: anyone signed in can read it, reply to it, and vote "me too" on it. The asker or staff can mark one reply as the **accepted answer**. Accepting sets the status to `answered`. Clearing it returns the status to `open`. Staff can close a question, which also locks it. Staff can convert a thread between all three types.

## Rulings

- **Q1.** Questions are readable by every signed-in account and open to replies from all of them, as suggestions are. Bugs keep their rules: every signed-in account can read them, and only the reporter and staff can reply.
- **Q2.** A question can have one accepted answer: one comment on that thread.
- **Q3.** Questions have their own category list.
- **Q4.** Filing a question adds the asker's own vote, as filing a suggestion does.
- **Q5.** Staff can convert a thread between all three types.
- **Q6.** The Formaquestion help window links to filing a question (client only).
- **Q7.** Question statuses are `open · answered · closed`. Accepting an answer sets `answered`. Clearing it sets `open`.
- **Q8.** The asker and staff can accept or clear an answer.
- **Q9.** A voter on a question is a party to it, so a reply marks it unread for them. Questions only; suggestions do not change.
- **Q10.** The asker can accept their own comment.
- **Q11.** Converting a question to a bug limits replies to the reporter and staff, as converting a suggestion to a bug does today. Any type change clears the accepted answer.
- **Q12.** The board defaults to `open`, sorted by votes (client).
- **Q13.** The help window's button shows under every answer and fills in the title (client).
- **Q14.** The new-question dialog lists matching questions while the player types the title.
- **Q15.** When the accepted comment is deleted, the question returns to `open` with no accepted answer.
- **Q16.** Questions get a tab in the staff Feedback tab and in My Feedback (client).
- **Q17.** The accepted answer shows as a pinned copy under the question body and keeps its place in the thread with a mark (client).
- **Q18.** Category names were settled by a copy sweep: `gameplay`, `editor`, `setup`, `community`, `account`, `other`.
- **Q19.** The list search gains word-based matching, ranked by how many words match. The duplicate check and the normal search box both use it.
- **Q20.** A duplicate-list result opens inside the Feedback dialog (client).
- **Q21.** A pre-filled open of the Feedback dialog asks before it replaces an unsent draft (client).
- **Q22.** The unread count includes questions for every client. A released client may show a badge it cannot clear until the player updates. Accepted.
- **Q23.** Staff are not a party to every question. Staff get unread only on questions they filed, replied to, or voted on.
- **Q24.** Closing a question also locks it. Reopening it unlocks it.

## User Stories

1. As a player, I want to file a question, so that other players or staff can answer it.
2. As a player, I want anyone signed in to be able to reply to my question, so that whoever knows the answer can give it.
3. As a player, I want my own "me too" vote counted when I file, so that the count starts at one.
4. As a player, I want to vote on someone else's question, so that it gets more visibility.
5. As a player, I want to remove my vote, so that I can take back a "me too".
6. As a voter, I want a reply on a question I voted on to show as unread, so that I learn when it gets an answer.
7. As a voter, I want the unread mark to clear when I open the question, so that the badge reflects only new replies.
8. As a voter, I want my own vote not to raise my badge, so that voting does not mark old replies as new.
9. As an asker, I want to mark one reply as the answer, so that later readers find it at once.
10. As an asker, I want to mark my own reply as the answer, so that a solution I found myself is recorded.
11. As an asker, I want to change or clear the accepted answer, so that I can correct a wrong pick.
12. As staff, I want to accept or clear an answer on any question, so that abandoned questions still get resolved.
13. As staff, I want closing a question to lock it, so that a duplicate or stale question stops collecting replies.
14. As staff, I want reopening a question to unlock it, so that a wrong close is fully undone.
15. As a reader, I want the status to read `answered` when an answer is accepted, so that the list shows which questions are solved.
16. As a reader, I want a question to return to `open` when its accepted reply is deleted, so that the status never points at a missing answer.
17. As staff, I want to convert a question to a bug, so that a reported fault goes to the bug queue.
18. As staff, I want to convert a question to a suggestion, so that a feature request lands on the suggestion board.
19. As staff, I want to convert a bug or a suggestion to a question, so that a misfiled question lands on the right board.
20. As a reader, I want search to match the words I type in any order, so that I find a question without its exact wording.
21. As a reader, I want results with more matching words first, so that the best match is on top.
22. As a reader, I want to filter questions by category and status, so that I can narrow the list.
23. As a reader, I want to sort questions by votes, newest, oldest, and activity, so that I can find the most wanted or the newest.
24. As a player, I want to see only my own questions, so that I can follow what I asked.
25. As an older client, I want bug and suggestion lists to stay unchanged, so that the released app keeps working.

## API Contract

Every route below already exists unless it says new. This effort widens them.

- **Type.** `question` joins `bug` and `suggestion` wherever a type is read or written: create, list, edit, and the audit log.
- **Categories.** A question takes one of `gameplay`, `editor`, `setup`, `community`, `account`, `other`. Each type keeps its own list. A category from another type's list is a 400, as create and edit already enforce.
- **Statuses.** A question takes one of `open`, `answered`, `closed`. New questions start `open`.
- **Status route.** On a question, staff may set only `open` or `closed`. `answered` comes only from accepting.
  - Setting `closed` also locks the thread (Q24).
  - Setting `open` on a closed question unlocks it. When the question has an accepted answer, the status becomes `answered`. A lock set through the lock route stays: only leaving `closed` unlocks.
  - A locked or closed question still takes votes, as a locked suggestion does.
- **Accept route (new).** `PUT /api/feedback/:id/answer` with `{ commentId: string | null }`.
  - The thread must be a question. Otherwise 400.
  - The caller must be the asker or staff. Otherwise 403.
  - A `commentId` must name a comment on this thread. Otherwise 400. Any comment qualifies, the asker's own included (Q10).
  - The status changes only between `open` and `answered`. A non-null `commentId` on an `open` question sets `answered`. `null` on an `answered` question sets `open`. On a `closed` question both store or clear the answer and the status stays `closed`.
  - A locked thread still allows accepting and clearing, for the asker and staff.
  - The route touches `updated_at`. It writes a `feedback_answer_set` audit entry when the caller is not the asker.
  - The response carries the thread in the same shape as thread detail.
- **Thread shape.** Every thread DTO, on every route that returns one (detail, status, vote, edit, accept), gains `acceptedAnswer`: the accepted comment in the comment shape (id, author, role, body, dates), or `null`. Only a question can have a non-null value.
- **Votes.** The vote route and the `votes` sort accept questions. Filing a question adds the asker's vote in the same transaction. A bug still refuses votes, and the refusal message names both votable types.
- **Read markers for voters.** Adding a vote on a question records a read marker for the voter, so old replies do not count as unread. Opening a question records a read marker for a voter, as it does for the asker and commenters.
- **Unread.** On a question, the parties are the asker, every commenter, and every voter (Q9). Staff are parties only by those same routes (Q23). The unread count includes questions (Q22).
- **Search (Q19).** The `search` parameter keeps its 200-character cut, then splits on whitespace. It drops words under 3 characters, except a 2-character word typed in all capitals (`AI`, `UI`). Each distinct word counts once, case-insensitive. A thread matches when any word appears in its title or body. With search text, results sort by the number of matching words, then by the chosen sort. Every type uses this; the duplicate check sends `type=question&scope=all` with no status filter.
- **Type change.** The existing staff-only edit converts between all three types. On any type change the accepted answer clears, the status returns to `open`, and diagnostics clear, as today. Votes stay. Converting into a question records a read marker for each existing voter, so the conversion does not raise their badge. Converting into a question does not add the reporter's vote, as converting into a suggestion does not today.

## Implementation Decisions

- **One tree, a third branch.** Questions live in the existing `feedback` table. No parallel table.
- **Rebuild with foreign keys off.** The `type`, per-type `category` and per-type `status` CHECKs each gain the question branch. SQLite cannot change a CHECK in place, so a new schema step rebuilds the table.
  - `feedback_comments`, `feedback_votes` and `feedback_reads` cascade on `feedback_id`, and the app runs with foreign keys on. Dropping `feedback` with enforcement on deletes every comment, vote and read marker.
  - The step follows the `eventPlacements` step: non-atomic, foreign keys off, its own transaction, `PRAGMA foreign_key_check` before commit, foreign keys back on. Do not copy the `placementTies` step, which is safe only because nothing points at its table.
  - The step knows it has run when the stored `CREATE TABLE feedback` SQL already names `question`.
  - It runs after the existing `feedback` column steps (`feedbackEdited`, `reporterRole`), so the rebuild keeps their columns.
  - The `CREATE TABLE feedback` definition for fresh databases gets the same CHECKs and the new column.
- **Accepted answer column.** `feedback.accepted_comment_id`, nullable, referencing `feedback_comments(id)` with `ON DELETE SET NULL`. It is added in its own step after the rebuild.
- **Delete trigger.** A `BEFORE DELETE ON feedback_comments` trigger sets the owning question's `accepted_comment_id` to NULL and, when the question was `answered`, its status to `open`. It must be `BEFORE`: SQLite applies the foreign-key action before an `AFTER` trigger runs, so an `AFTER` trigger never sees the match. Comments are deleted by their author or by staff. Account deletion sets a comment's author to NULL and keeps the comment, so the accepted answer survives with no author. This is the schema's first trigger. A later rebuild of `feedback` must drop and recreate it.
- **Public-board predicate.** The model's `TYPES`, `CATEGORIES` and `STATUSES` gain the question entries. Every check on `type === 'suggestion'` that decides reply rights or votes becomes one shared "votable board" predicate, true for suggestions and questions.
- **Participation.** The participation clause and `hasParticipated` gain the question branch with voters included. Both must agree, or a voter's marker never clears.
- **Audit.** `feedback_answer_set` joins the server's audit `ACTIONS`. There is no database CHECK on the action. A released staff client shows an empty badge for it; accepted.
- **Compatibility.** The released client always sends `type` when it lists, so it never receives a question row. Thread DTOs gain a field and lose none. The unread count is the one change a released client can see (Q22).

## Testing Decisions

- Test through the HTTP API with supertest, as the existing feedback suites do. Assert on responses and on what a second account can see and do. Never assert on SQL.
- One new suite for questions covers:
  - Filing: category list, auto-vote.
  - Replies: a stranger can reply to a question; a stranger still cannot reply to a bug.
  - Votes and the votes sort.
  - Accepting: by the asker, by staff, a stranger refused, the asker's own comment, a comment from another thread refused, a non-question refused, on a locked question, on a closed question.
  - Status: the status route refuses `answered`; closing locks; reopening unlocks and returns `answered` when an answer exists.
  - Deleting the accepted comment by its author and by staff, with foreign keys on. Deleting the author's account keeps the answer with a null author.
  - Unread for the asker, a commenter and a voter. A voter's vote does not raise their badge; opening the question clears it.
  - Conversion in all six directions: the answer clears, votes stay, voters' badges do not rise.
  - Word search: words in any order, ranking by matching words.
- Each guard gets a check that fails when the guard is removed: a stranger accepting, a bug taking a vote, `answered` set through the status route.
- Migration: build the old table with rows in every state and with comments, votes and read markers. Run the schema. Read every row back intact. Then insert a question. Run it on both the fresh path and the migrated path, and assert the trigger exists on both. The boot-schema drift test compares only columns, keys and indexes, so it cannot see CHECKs or triggers.
- Update the tests that pin today's two types: the type list in `tests/feedback.test.js`, the vote refusal message, and the create response's `voted` field.
- Prior art: `tests/feedback.test.js`, `tests/feedbackEditing.test.js`, `tests/feedbackHardening.test.js`, the `eventPlacements` step's tests.

## Out of Scope

- Email or push notifications. The unread badge stays the only signal.
- Changing who can read or reply to bugs.
- Merging duplicate questions. Staff close the duplicate and link the original in a reply.
- Votes or reactions on individual comments.
- Feeding answered questions into Formaquestion retrieval.

## Further Notes

- Old content on the live server must survive the rebuild. Take a backup before deploying, and run the migration test against a copy of the production database first.
- The server ships before the client.
