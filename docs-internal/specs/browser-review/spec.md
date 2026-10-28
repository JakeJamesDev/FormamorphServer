# Spec: Browser review (server)

Status: ready-for-agent

Client side: the formamorph repo, `docs-internal/specs/browser-review/spec.md`. That spec holds the rulings (Q1–Q13). This spec covers the one server change they need.

## Problem Statement

Staff can review in the Community Creations browser. A pinned update card must show the pending name and thumbnail (client Q12). Catalog rows carry only `has_pending_update`. The pending payload is on the single-listing route alone. Fetching details for each pinned card costs one request per card.

## Solution

Catalog rows from `GET /worlds` carry a small `pending_preview` when the listing has a pending update and the viewer is staff or the author.

## User Stories

1. As a mod, I want catalog rows to carry the pending name, so that a pinned update card shows it without another request.
2. As a mod, I want catalog rows to say whether a pending thumbnail exists and where, so that the card loads it only when there is one.
3. As a player, I want catalog rows without any pending data, so that I learn nothing about edits under review.
4. As an author, I want my own rows to carry the preview, so that my client can show it later.
5. As a mod, I want the catalog ETag to change when a pending update arrives or is decided, so that my browser never keeps a stale preview.

## Implementation Decisions

- **Contract.** `pending_preview: { name: string, queued_at: string, thumbnail_url?: string }`.
  - Present only when the row has a pending update.
  - `name` is the pending name, or the approved name when the update does not change it.
  - `queued_at` is the pending update's queue time, the same value the Review queue sorts by. The client orders its pinned group with it.
  - `thumbnail_url` is the existing `/api/reviews/<worldId>/thumbnail` URL, present only when the update holds a thumbnail. That route's auth is unchanged.
- **Query.** `World.getAll` reads the preview in the same SELECT as `has_pending_update`, from the `pending_updates` table. No per-row query.
- **Stripping.** `stripModeration` removes `pending_preview` for anyone but staff and the author, with the other moderation fields.
- **Freshness.** The catalog tag must move whenever a row's preview moves. `catalogFreshness.test.js` pins this without inspecting how the tag is computed.

## Testing Decisions

- Test through the route with the existing `listingReview.test.js` and `catalogFreshness.test.js` patterns.
- Cases: staff see the preview; the author sees it; another signed-in user and an anonymous reader don't; a pending update without a thumbnail has no `thumbnail_url`; a row with no pending update has no preview; the ETag changes when an update is submitted, approved and rejected.
- The stripping case must fail when the field is left out of `stripModeration`.

## Out of Scope

- Any change to the review routes or their auth.
- A paged or filtered staff queue on `GET /worlds`.
