# Spec: Listing details speed (server)

Status: ready-for-agent

Client side: the Formamorph repo, `docs-internal/specs/listing-details-speed/spec.md`. This spec is the server half.

## Problem Statement

The details window in the client can't know whether a listing has a Listing Changelog until it asks for the listing on its own. Until then it can't set its Changelog | Comments switch, so the window changes shape when the answer arrives. The catalog already carries a comment count for each row; it carries nothing about the changelog.

## Solution

Each catalog row carries how many Changelog Entries the listing has. The count stays correct as authors add and delete entries, and the catalog's freshness tag changes when it does.

## User Stories

1. As a client, I want `changelog_count` on every catalog row, so that I can set the details window's switch before I fetch the listing.
2. As a client, I want the count to go up when an author adds an entry, so that the catalog stays true.
3. As a client, I want the count to go down when an author deletes an entry, so that the catalog stays true.
4. As a client, I want an edit to an entry to leave the count alone, so that edits don't look like new entries.
5. As a client holding a cached catalog, I want the catalog tag to change when a count changes, so that my revalidation picks it up.
6. As the operator, I want existing listings backfilled with their real counts, so that the field is right from the first deploy.
7. As the operator, I want the count to stay out of `updated_at`, so that changelog work never marks a listing as updated.

## Implementation Decisions

- **Q1. A stored counter, maintained on write.** `worlds.changelog_count` follows the `comment_count` pattern: it goes up on entry create and down (never below zero) on entry delete, in the same transaction as the entry write.
- **Q2. Backfill at boot.** The schema step adds the column with a default of zero and sets each row from its real entry count, once.
- **Q3. No `updated_at` change.** The counter write leaves `updated_at` alone, as every changelog write does today.
- **Q4. The catalog list selects it.** The list response includes `changelog_count` on every row. The single-listing response may carry it too; the client reads the changelog there.

API contract: catalog rows gain `changelog_count` (integer, zero or more). Additive.

## Testing Decisions

Tests drive the routes with supertest and check the list response, as in the existing changelog and catalog freshness tests.

- The count on a listing with none, after adds, after a delete, and after an edit.
- The catalog tag changes after an add and after a delete, and a `304` stops matching.
- The backfill sets real counts on rows that predate the column.
- `updated_at` is unchanged after each changelog write.

## Out of Scope

- Any change to the changelog routes' responses.
- Counts for Linked Content or Compatible Worlds (possible next iteration; see the client spec).
