# Spec: Feedback on the website (server)

Status: ready-for-agent

Client side: the formamorph repo, `docs-internal/specs/website-feedback/spec.md`. That spec holds the rulings (Q1–Q10) and the user stories. This spec holds the read-access contract.

## Problem Statement

Every feedback read requires sign-in. The website needs guests to read suggestions and questions, so a signed-out visitor sees nothing.

## Solution

Make three feedback reads optional-auth. A guest can list and read the Votable boards (suggestions and questions) and read the meta. A guest can never list or read a bug. Every write stays signed-in only.

## User Stories

1. As a guest, I want to list suggestions and questions, so that the website board can show them.
2. As a guest, I want to read one suggestion or question with its comments, so that a shared link works.
3. As a guest, I want the board's types, categories, statuses and caps, so that the website filters work.
4. As a guest, I want a bug ID to answer not-found, so that bug reports stay out of public view.
5. As a guest, I want a bug-type list request refused, so that the bug queue never leaks to the web.
6. As a signed-in user, I want reads to behave exactly as today, so that the app does not change.
7. As a guest, I want my reads to leave no trace, so that no seen-marker or vote lookup runs without an account.

## Implementation Decisions

- **Contract.**
  - `GET /api/feedback/meta`: `optionalAuth`. Same body for everyone.
  - `GET /api/feedback`: `optionalAuth`. A guest must send `scope=all` and a Votable board type. A guest request for type `bug`, or without `scope=all`, answers 401 (sign-in needed), not an empty list. Guest rows carry `voted: false` and `unread: false`.
  - `GET /api/feedback/:id`: `optionalAuth`. A guest reading a bug answers 404, the same as a missing thread. A guest read records no seen-marker. `voted` is false.
  - `GET /api/feedback/unread-count` and every write route stay `protect`.
- **One rule, in the model.** The read check takes an optional user. A thread is guest-readable when its type is a Votable board. The signed-in rule does not change.
- **Rate limit.** Guest reads use the global limit. No new limiter.
- **No schema change.**

## Testing Decisions

- Extend the existing feedback route tests (prior art: the feedback, editing, hardening and questions route tests). Assert status codes and bodies through the real router.
- Cover a guest listing each Votable board, a guest bug list (401), a guest list without `scope=all` (401), a guest reading a suggestion and a question, a guest reading a bug (404), a guest meta read, and guest writes (401 each).
- Prove the guest read leaves no seen-marker row and runs no vote lookup.
- Prove the signed-in paths are unchanged by keeping the existing tests green.
- Prove the bug guard bites by removing the type check once and watching the guest bug tests fail.

## Out of Scope

- The app's bug queue exposure to signed-in users (client spec Q4).
- Mentions and links in feedback text (separate effort).
- Any new limiter or caching for guest traffic.
