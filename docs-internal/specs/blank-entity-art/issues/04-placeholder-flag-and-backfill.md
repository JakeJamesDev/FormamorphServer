# 04: Placeholder Flag and Backfill

Status: ready-for-agent
Blocked by: None (can start immediately)
Recommended model: Claude Sonnet 5 (`claude-sonnet-5`)
Reasoning effort: high

**Parent:** [Blank Entity Art (server part)](../spec.md). Numbered to match the client spec's tickets.

**What to build:** Each listing says whether its thumbnail is the server's stand-in. A new `placeholder` column records it, the API returns it, and a one-time backfill sets it on existing entity listings that carry the silhouette.

**Rationale for the model:** a schema step, the publish and update paths, and a backfill against live data. Sonnet at high effort, because the backfill must be exact.

## Acceptance criteria

- [ ] A schema step adds `placeholder INTEGER NOT NULL DEFAULT 0` to the listings table through `addColumns`.
- [ ] Publish: an entity published without a thumbnail gets `placeholder = 1`. The server still stores its stand-in copy, so older clients keep working.
- [ ] Update: an update that sends a thumbnail sets `placeholder = 0`. An update without one leaves the flag as it is.
- [ ] Every response that carries a listing includes `placeholder` as a boolean: lists, the slim list, details, profiles and likes.
- [ ] Backfill: entity rows whose stored thumbnail bytes equal the stored copy of `assets/placeholders/entity.png` get `placeholder = 1`. First check whether `saveThumbnail` re-encodes its input. If it does, compare against the re-encoded bytes. The backfill is safe to run twice, and it reports how many rows it flagged.
- [ ] The backfill runs only when the user starts it. It never runs by itself at startup.
- [ ] Avatar listings are never flagged.
- [ ] Tests cover publish with and without a thumbnail, an update that adds art, the response field, and the backfill on a matching row, a non-matching row and an avatar row.
- [ ] Server tests pass. Report their wall time.

## Scope notes

- API shape change only: the listing gains `placeholder`. Nothing in world or save files changes.
- The user runs the backfill on the live server after deploy.
