# Spec: Links in Feedback Threads (server)

Status: ready-for-agent

Client side: the formamorph repo, `docs-internal/specs/feedback-links/spec.md`. That spec holds the rulings (Q1–Q38) and the user stories. This spec holds the thread number, mention and link-target contract.

## Problem Statement

Feedback threads have only a UUID, so nobody can name one in text. The server knows nothing about users or content a post refers to, so a mention cannot badge anyone.

## Solution

Give every thread a short number. Parse thread bodies and comments on write, record user mentions, and fold them into the participation rule that drives the feedback badge. Resolve each post's link targets per reader on read. Add the two searches the editor's autocomplete needs.

## User Stories

The client spec holds the full list. The server owns these:

1. As a player, I want every thread to have a number from one shared sequence, so that `#23` names one thread.
2. As a mentioned player on a suggestion or question, I want the thread to count as mine, so that it badges me.
3. As a mentioned player, I want the claim to follow the current text, so that an edit or a delete updates it.
4. As a reporter, I want mentions in a bug to grant no claim, so that nobody joins the bug queue by mention.
5. As a poster, I want the mention cap enforced by role, so that mentions cannot be used to spam.
6. As a reader, I want link targets resolved for me, so that I never see a name or title I should not.
7. As a writer, I want username and thread searches for autocomplete, so that I can pick a target.

## Implementation Decisions

- **Thread number.** A schema step adds a unique, non-null `number` to feedback, one sequence across all types. It backfills existing rows in creation order (ties broken by id). New threads take the next number from a never-reused counter, seeded from the backfill and advanced in the insert's transaction, so a deleted thread's number stays dead (client Q30). Every thread DTO returns `number`. The thread read (`GET /api/feedback/:id`) accepts a number as well as the UUID; other routes take the UUID.
- **Mentions table.** A `feedback_mentions` record holds (thread, source post, mentioned user). The source is the thread body or one comment. It cascades on thread, comment and user delete. Writes to a body or a comment replace that source's rows in the same transaction.
- **Parse on write.** The grammar matches the client spec: skip fenced code and inline code, word boundary before `@` and `#`, case-insensitive usernames. Only names that resolve to an account whose profile is shown are recorded (client Q34). Self-mentions are dropped. Repeats count once.
- **Cap.** Distinct mentioned users per post, after self and unknowns are dropped: admin no cap, moderator and dev 10, everyone else 5. Over the cap, the write is refused with a 400 that names the cap. The role is the writer's role at write time.
- **Participation.** `participationClause` and `hasParticipated` gain one branch: on a suggestion or question, a mention row for the user makes them a party. Bugs gain nothing. The two must still agree, and `unreadCount` and `unreadAmong` follow from them.
- **Per-reader targets.** Each thread and comment DTO carries the resolved targets for its own text: users (id, username, avatar), threads (number, title, type, status) and listings (kind, id, title, thumbnail). A target the reader cannot read, or that does not exist, comes back as unavailable with no name, title or type. A thread is readable by the existing `canRead` rule. On the guest read path from the website effort, bugs are never readable. A listing is readable only when it is publicly visible.
- **Autocomplete reads.** `GET /api/feedback/search/users` and `GET /api/feedback/search/threads`, 8 results each, rate-limited per account. The username search matches mentionable, shown accounts by prefix and ranks the given thread's participants first; an empty query with a thread returns those participants. The thread search matches number prefix or title words over threads the caller can read, with an optional `types` filter (client Q31, Q34).
- **Thread URL form.** The website and app address threads as `/feedback/<number>`.

## Testing Decisions

- Tests go through the HTTP API with supertest, as the existing feedback tests do. Prior art: the feedback, feedback editing and feedback questions tests.
- Cover: numbering and backfill order; read by number; mention recording on create, edit and delete; cap per role and the refusal; self and repeat handling; unknown users; the badge count with mentions on each type; per-reader target resolution for readable, unreadable and missing targets; both searches and their read rules.
- **Grammar case table.** This repo holds the canonical table; the client copies it and runs its own parser against it. The two copies must match.
- Prove each guard bites: remove the bug branch exclusion and the bug-mention test must fail.

## Out of Scope

- Inbox messages or email for mentions.
- Closing the open bug-read rule. `canRead` still lets any signed-in user read bugs, and `toThreadDto` still returns diagnostics to every reader.
- Links in thread titles.
