# Spec: Username Spaces (server)

Status: done
Status note: Closed 2026-10-27. Tickets 01–03 landed here (last 3078f867c4); the client spec holds the close record.

Client side: the formamorph repo, `docs-internal/specs/username-spaces/spec.md`. That spec holds the rulings (Q1–Q11) and the user stories. This spec holds the folded key, the re-flag pass and the lookup contract.

Follows `docs-internal/specs/username-charset/` (closed).

## Problem Statement

The rule in `src/config/username.js` allows only `[A-Za-z0-9_-]`. The `usernameRename` schema step flagged every account with an inner space. Lookups fold case only (`COLLATE NOCASE`), so "Jake James" and "Jake_James" are two names, and no mention can reach a name with a space.

## Solution

Registration and rename accept single inner spaces. A folded key (ASCII lowercase, space to `_`) backs uniqueness, mention resolution, username search and profile lookup. The key step clears flags under the new rule when it adds the key.

## User Stories

1. As the client, I want registration and rename to accept "Jake James", so that the server and the client apply one rule.
2. As the client, I want "Jake  James" stored as "Jake James", so that a doubled space never reaches the database.
3. As the client, I want "Jake_James" refused with `USERNAME_TAKEN` when "Jake James" exists, so that the fold is the uniqueness rule.
4. As a mentioning player, I want `@Jake_James` resolved to "Jake James", so that a spaced name can be mentioned.
5. As a searching player, I want "jake james" and "jake_james" to find the same account, so that search matches mentions.
6. As a profile reader, I want `/u/Jake_James` and `/u/Jake%20James` to open the same profile, so that both links work.
7. As a flagged player whose name passes the new rule, I want the flag cleared at deploy, so that I keep my name.
8. As the operator, I want the clearing pass to run once on live data, so that the counts are current.

## Implementation Decisions

- **Rule.** `src/config/username.js` holds the new pattern: 3–20 characters of `[A-Za-z0-9_-]` and single inner spaces, with no space at either end. `USERNAME_RULE` takes the client spec's Q11 text. `checkUsername` trims, collapses space runs, then checks.
- **Folded key.** A `username_key` VIRTUAL generated column holds the folded name, `replace(lower(username), ' ', '_')` (client Q14). A schema step adds it, so every writer carries it without setting it. An index on it serves every lookup. It is not unique: dormant flagged twins keep their names (username-charset Q15).
- **Lookups.** `findAllByUsernameFolded` and `findAllUnflaggedByUsernamesFolded` compare the folded key of the argument with `username_key`. Profile lookup, mention resolution, the uniqueness check and the username search (`User.js` list filter and the feedback mention suggestions) all go through the key.
- **Re-flag pass.** The `usernameKey` step, in the run that adds the key (client Q18), recomputes `username_rename_required` (client Q6):
  - Clear the flag on every account whose name passes the new rule and that has no twin under the key.
  - In a twin group, an account whose name passed the old rule keeps the name, and every other member stays or becomes flagged.
  - When no member passed the old rule, the oldest (`created_at`, then `id`) keeps the name.
  - Never flag an account that the old pass left unflagged. The placeholder is never flagged.
- **Rename suggestion.** `renameSuggestion` keeps single inner spaces and drops only characters outside the new set.

## Testing Decisions

- The rule table gains the client spec's new cases, including a doubled space and a space at either end.
- The uniqueness test registers "Jake James" and asserts "jake_james" is refused with `USERNAME_TAKEN`.
- Mention resolution, profile lookup and search each get a test with a spaced account found by its underscore form.
- The re-flag step gets a fixture database covering: a spaced name with no twin (cleared), a spaced name twinned with an unflagged underscore name (stays flagged), two flagged twins (oldest cleared), and the placeholder. Prior art: the `usernameRename` step tests.

## Out of Scope

- A unique index on the key. It cannot exist while dormant flagged twins remain.
- Any change to sign-in or forgot-password lookup, which match the stored name byte for byte (client Q15). World search by author does fold.

## Further Notes

- Feedback-links mention resolution and the username search read through the same `User` helpers, so the key change reaches them without a second copy.
