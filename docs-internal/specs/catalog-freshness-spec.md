# Spec: Catalog freshness (server)

Status: ready-for-agent

Client side: the Formamorph repo, `docs-internal/specs/thumbnail-cache-spec.md`. This spec is the server half.

## Problem Statement

Every time a reader opens Community Creations, the app fetches the whole catalog again — every Listing of every Kind, in one request — and rewrites its local copy from scratch. On most opens nothing has changed. The server already computes an `ETag` for that response and answers `304 Not Modified` when asked, but a browser client cannot use it: the header is not exposed across origins, the conditional request header is not allowed through the CORS preflight, and nothing tells a shared cache that a signed-in reader's copy differs from an anonymous one.

## Solution

Make the list endpoint's existing freshness check reachable from a browser, and pin it so it cannot regress.

- The catalog list answers with an `ETag` a cross-origin client can read, and accepts `If-None-Match` from one.
- When the tag still matches, the list answers `304` with no body.
- The tag changes whenever anything a list row carries changes: a Listing published, edited, deleted, quarantined, or released; a Like added or removed; a Comment added or deleted; a download counted; an Author's username or avatar changed.
- The response says it is private and must always be revalidated, and that it varies by who is asking, so no cache anywhere serves one reader's list to another.

## User Stories

1. As a reader, I want the catalog to open without re-downloading a list that has not changed, so that Community Creations opens faster on every visit after the first.
2. As a reader, I want a change to any Listing to reach me on my next open, so that a faster catalog is never a stale one.
3. As a reader, I want a new Like on any Listing to change the catalog's tag, so that counts on the cards stay right.
4. As a reader, I want a new Comment on any Listing to change the tag, so that comment counts stay right.
5. As a reader, I want a download of any Listing to change the tag, so that download counts stay right.
6. As a signed-in reader, I want my own list — with my liked marks and any quarantined Listing of mine — never to be served to a signed-out visitor from a cache, so that quarantine stays private.
7. As a signed-out visitor, I want never to receive a signed-in reader's list from a cache, so that I see only what the room sees.
8. As an Author, I want a quarantine or a release of my Listing to change the tag, so that the catalog I see reflects it at once.
9. As an Author, I want my username or avatar change to change the tag, so that my cards read right on the next open.
10. As staff, I want a Like I removed to change the tag, so that the corrected count reaches every reader.
11. As a client developer, I want the `ETag` header readable from a cross-origin `fetch`, so that the app can store it beside its cached catalog.
12. As a client developer, I want `If-None-Match` accepted by the CORS preflight, so that the app can send it without the browser refusing the request.
13. As a client developer, I want a `304` answer to carry the same `ETag` as the `200` it stands in for, so that a stored tag can be confirmed rather than replaced.
14. As the server's operator, I want this pinned by tests, so that a future middleware change cannot silently turn the tag off.
15. As the server's operator, I want no change to the response body or to any other endpoint, so that clients written before this keep working untouched.

## Implementation Decisions

**Vocabulary.** *Catalog* is the full list the browser fetches: every Listing of every Kind, in one request. *Tag* is the response's `ETag`. *Conditional request* is a request carrying `If-None-Match`.

**Keep the framework's tag.** The tag stays the weak, body-hash `ETag` the web framework already emits. It changes by construction whenever the body changes, which is exactly the contract: the list row carries the like count, the comment count, the download count, the quarantine columns, and the Author's username and avatar, so any of those changing changes the body and therefore the tag. No derived or maintained validator is built. A test pins each of those changes to a new tag, so the guarantee survives a change to how the tag is computed.

**Expose the tag across origins.** The CORS middleware gains `ETag` in its exposed response headers and `If-None-Match` in its allowed request headers. Both apply to every route; the middleware is one app-level configuration and the other endpoints gain nothing but a harmless header.

**Freshness headers on the list only.** The catalog list route sets `Cache-Control: private, no-cache` and `Vary: Authorization`. *Private* keeps it out of shared caches; *no-cache* means a stored copy is always revalidated, never served blind; *Vary* keys any private cache by the credential, so a signed-in reader's copy and an anonymous copy cannot be confused. Nothing else on the server sets a `Cache-Control` today, and no other endpoint gains one here.

**The `304` carries the tag.** The framework already repeats the `ETag` on a `304`. The test asserts it, so the client can compare rather than assume.

**No schema change.** No table, column, or step changes. No version bump.

**Not built: a cheap validator.** Answering `304` still runs the full catalog query to hash the body. That saves the network and the client's whole rewrite, which is what the reader feels; it saves the server nothing. A validator derived from the tables (counts and maximum ids) or maintained on every write is a later effort, listed under Out of Scope.

## Testing Decisions

**One seam: the app through supertest.** Every test sends real requests to the app the way `worlds.test.js` and `likes.test.js` do, creating Listings, Likes, and Comments through the API, and reads headers and status off the response. No middleware is called directly. No mock of the framework.

**What a good test looks like here.** It asks for the catalog, changes one thing through the public API, asks again with the old tag, and asserts the status. It never inspects how the tag is computed.

**Coverage to write**, in one new test file beside the others:

- A first fetch carries an `ETag`; a second fetch with that tag in `If-None-Match` answers `304` with an empty body and the same `ETag`.
- After each of the following, the same conditional request answers `200` with a different tag: a Listing published; a Listing edited; a Listing deleted; a Like added; that Like removed by its owner; a Like removed by staff; a Comment added; a Comment deleted; a download counted; a Listing quarantined; that Listing released; the Author's username changed; the Author's avatar changed.
- A signed-in reader's tag differs from a signed-out visitor's for the same catalog, and each answers `304` only to its own tag.
- The list response carries `Cache-Control: private, no-cache` and `Vary: Authorization`; a Listing detail response and the auth endpoints do not gain a `Cache-Control`.
- A CORS preflight for the list route lists `If-None-Match` among the allowed request headers, and the list response lists `ETag` among the exposed headers.

**Prior art.** `worlds.test.js` for the catalog fixtures and the `create` helper; `likes.test.js` and `likeModeration.test.js` for liking and staff removal; `quarantine.test.js` for quarantine and release; `avatars.test.js` for an avatar change.

**Bar.** Each change-detection case is checked to fail when its write is skipped. No fixture is shaped so a change cannot register. The full suite passes.

## Out of Scope

- A validator cheaper than hashing the body — derived from table counts and maximum ids, or maintained on every write. That is the step that saves the server work, and it needs its own design because every write site that touches a list row must bump it.
- A `?since=` delta endpoint. Listings are hard-deleted, so a delta cannot report removals without a tombstone table.
- `Cache-Control` on image assets, thumbnails included. The client's thumbnail cache is its own effort.
- Any change to the response body, pagination, or the `kind` default.
- `Cross-Origin-Resource-Policy` on thumbnails. A separate question, noted in the client spec.

## Further Notes

Probed before writing: against the current server, an anonymous `GET /api/worlds?kind=all&limit=1000` answers with `ETag: W/"…"` and no `Cache-Control`, and a second request with `If-None-Match` answers `304`. A signed-in request answers with a different tag. So the freshness mechanism exists today; this spec makes it usable from a browser and pins it.

The client will send `If-None-Match` itself and fetch with the browser's HTTP cache bypassed, so it can see the `304` and skip its local rewrite. Left to the browser's own cache, a `304` is turned into a `200` with the stored body before the app sees it, and the app would rewrite its copy anyway.
