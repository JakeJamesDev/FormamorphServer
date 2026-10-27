# Spec: Username Character Rule (server)

Status: ready-for-agent

Client side: the formamorph repo, `docs-internal/specs/username-charset/spec.md`. That spec holds the rulings (Q1–Q18) and the user stories. This spec holds the flag, gate and rename contract.

## Problem Statement

Registration checks length only and compares names byte for byte. So names exist that a mention cannot reach: names with spaces, dots and other symbols, and the newer account of each `Alice`/`alice` pair.

## Solution

Registration enforces `[A-Za-z0-9_-]{3,20}`, unique ignoring case. A one-time schema step flags every existing account that breaks the rule, and every account in a case-twin group except the oldest. A flagged account signs in as before. Its writes are refused with a dedicated code until it calls the rename route. Username search and mention resolution skip flagged accounts.

## User Stories

1. As the client, I want registration to refuse a bad name with a code, so that I can show the rule.
2. As the client, I want a name taken ignoring case refused with its own code, so that I can say the name is taken.
3. As the client, I want the signed-in account to carry its rename state and a suggestion, so that I can open the rename screen at once.
4. As the client, I want a flagged account's writes refused with one code, so that I can open the rename screen from any action.
5. As the client, I want a rename route that works while the account is gated, so that the player can get out of the gate.
6. As the client, I want the rename reply to carry the updated account, so that I can refresh the stored account in one step.
7. As a mentioning player, I want mention resolution to skip flagged accounts, so that `@alice` reaches the account that keeps the name.
8. As the operator, I want the flagging step to run on live data at deploy, so that the counts are current.
9. As the operator, I want the gate off until the matching client ships, so that older builds are not stuck behind a refusal they cannot answer.

## Implementation Decisions

- **Flag.** A users column records that a rename is required, default off. A schema step sets it once: for every name outside the rule, and for every account in a case-folded group except the oldest (`created_at`, then `id`). The deleted-account placeholder is never flagged.
- **Registration.** Trims the name, then checks the pattern, then checks uniqueness ignoring case against every account, flagged ones included. Refusals are 400 `{ success: false, code, error }`: `USERNAME_INVALID` with `error` "3–20 letters, numbers, _ or -", or `USERNAME_TAKEN` with "Username already exists". A missing or empty name keeps the validator's "Username is required" with no code. One rule function returns the trimmed name or the refusal, including the lookup ignoring case; the rename route calls it with the caller's own id excluded. Admin and seed account creation stay outside the rule (ticket 01 intent answers).
- **Account payload.** The account in the sign-in reply and in the current-account read carries `usernameRename`: `{ required: true, suggestion }` for a flagged account, else `null`. The suggestion is the old name trimmed, whitespace runs turned into `_`, other characters outside the set dropped, cut to 20. It is `null` when the result is under 3 characters or is taken ignoring case.
- **Gate.** `protect` refuses a flagged account's non-GET requests with 403 `{ code: 'USERNAME_RENAME_REQUIRED', error: 'Update Formamorph to choose a new username.' }`. The Privacy Policy refusal answers first, then the suspension refusal, then this one, so a suspended flagged account never loops between the rename dialog and a suspension refusal. The exemptions are the routes that already skip the policy gate, plus the rename route and account deletion.
- **Cutover.** The gate refuses nothing until a server setting enables it. The setting is an admin-only boolean key in the settings table, `username_rename_gate`, default off (ticket 04 intent answer). The flag step and the rename route work from deploy. The operator enables the gate after the client release that answers the code.
- **Rename route.** An authenticated, rate-limited call for the signed-in account. It takes a name, applies the registration checks with the same codes, writes the name, clears the flag, and returns the account payload. An unflagged account is refused; a general rename is out of scope. Ticket 03 intent answers: the route is `POST /api/auth/username` with `{ username }`, and it answers `{ success: true, user }` with no new token. It uses `authLimiter`. The Privacy Policy gate answers first, and a suspended account is refused as on any write. Each rename writes one `username_changed` audit row: the actor is the account, the target name is the old name, and the snippet is the new name. `usernameRename` sits in the shared account summary, so every reply that carries the account carries it. The flag step flags only when it adds the column, so admin or seed accounts created later are never flagged.
- **Search and mentions.** The feedback username search (feedback-links Q31) returns only unflagged accounts. Mention resolution folds case and picks the oldest unflagged match. A name that only flagged accounts hold resolves to no account (ticket 05 intent answer). The feedback-links tickets own those reads; this spec adds the filter.
- **Unchanged.** Sign-in still matches the stored name byte for byte. The profile lookup by name keeps exact spelling, then the oldest folded match. Staff logs and report snapshots keep the name as recorded.

## Testing Decisions

- HTTP tests through the existing request harness, against replies only.
- Registration: valid name, each refusal code, a trailing space trimmed, a case twin refused.
- Flag step: a seeded database with a spaced name, a dotted name, a case-twin pair and the placeholder. Only the spaced, dotted and newer-twin rows are flagged. Prior art: the boot-schema and placeholder tests.
- Gate: a flagged account's write is refused with the code; a GET passes; the rename route and account deletion pass; the gate is silent while disabled. Prior art: the privacy-gate and suspended-access tests.
- Rename: success clears the flag and the next write passes; a taken name and an invalid name are refused; an unflagged account is refused; the old name then gives a profile "not found".
- Search and mentions: a flagged twin never appears in search, and a mention of the shared name resolves to the unflagged account. Prior art: the feedback-links tests.

## Out of Scope

- Usernames shaped like email addresses as a privacy problem.
- A general username change, aliases or redirects for old names.
- A database-level unique index ignoring case. It cannot exist while dormant flagged twins remain.
