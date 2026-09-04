# Spec: Drop the preview_data column

Status: ready-for-agent

Client side: the formamorph repo, `docs-internal/specs/drop-preview-data/spec.md`. Build this server half first. The client half only stops sending a field the server will already ignore, so either order is safe, but this one lets the client change be verified against a live server.

## Problem Statement

Every listing row carries a copy of its own thumbnail as base64 text inside a JSON field, next to the thumbnail file already stored on disk. Nothing ever reads that copy back. The server strips it from every response, and no route, script, or client path opens it. It exists only because the first publish flow sent it and the table kept it.

The copy is 500 MB of a 574 MB database. Every nightly backup, every off-site database snapshot, and every restore carries it. It is the reason the off-site backup store sits over its free tier, and it grows with every published world.

## Solution

Remove the field from the table, stop accepting it on publish and update, and reclaim the space in the live database. After this, a database copy is a couple of megabytes, and the thumbnail files on disk remain the single source of listing art, as they already are for every reader.

A client that still sends the field keeps working. The server ignores it.

## User Stories

1. As the operator, I want the database to hold only data something reads, so that backups are small and fast.
2. As the operator, I want each nightly database snapshot to be a few megabytes, so that fourteen days of history fits inside the off-site free tier with room to grow.
3. As the operator, I want a restore from a snapshot to take seconds instead of minutes, so that recovery after a bad change is quick.
4. As the operator, I want the existing live database to shrink after the deploy, so that the change pays off at once rather than only for new rows.
5. As the operator, I want the space reclaimed by a documented one-time step, so that I know when the disk frees up and that the service is stopped for it.
6. As the operator, I want the schema change to run itself on boot like every other step, so that a deploy needs nothing run by hand except the reclaim.
7. As the operator, I want the schema change to be safe to run twice, so that a restart after a partial deploy does not fail.
8. As the operator, I want a fresh database and a migrated old one to end up the same shape, so that the drift test keeps proving deploys are safe.
9. As a publisher on the current client, I want my publish to succeed after the server deploys, so that a client update is not required to keep publishing.
10. As a publisher on the current client, I want my listing update to succeed after the server deploys, so that editing keeps working across the client rollout.
11. As a publisher on the updated client, I want my publish request to be smaller, so that publishing a world with a large thumbnail is faster.
12. As a publisher, I want my listing's name, description, and thumbnail to appear in the catalog exactly as before, so that nothing visible changes.
13. As a reader, I want listing thumbnails to load exactly as before, so that the catalog looks the same.
14. As a reader, I want the world detail page to show the same name and description as before, so that nothing visible changes.
15. As a developer, I want the API reference to stop listing the field, so that a new client is not written to send it.
16. As a developer, I want the test payload helper to stop sending the field, so that tests match the client that will exist.
17. As a developer, I want the old-schema fixture in the drift test to still carry the field, so that the test proves the drop runs against a real old database.
18. As a developer, I want the raw-insert fixtures in the older tests to stop naming the column, so that they run against the new shape.
19. As the operator, I want the server doc to record the reclaim step and the new backup sizes, so that the next person knows what happened and why.

## Implementation Decisions

**Vocabulary.** A *listing* is one row in the worlds table, of any kind. The *thumbnail file* is the image stored on disk for a listing and served by the thumbnails route. The *preview field* is the JSON text column being removed.

**Schema step.** A new step in the schema step list, after the kind step and before the indexes, drops the preview field from the listing table when the column exists and does nothing otherwise. It uses the engine's native drop-column statement, which the bundled engine supports. The table definition for a fresh database no longer includes the field. The step is atomic like the others.

**Reclaiming space.** Dropping a column does not shrink the file. The reclaim is a one-time `VACUUM` run by hand on deploy day with the service stopped, because a vacuum cannot run inside a transaction and rewrites the whole file. It is documented in the server doc as part of this deploy, alongside the expected before and after sizes. It is not part of the boot step.

**Publish and update.** The publish controller stops reading the preview field from the request body and stops passing it to the listing model. The update controller does the same. A body that still carries the field is accepted and the field is ignored, so the current client keeps publishing across the rollout. No validation error is added for its presence.

**Listing model.** The create method no longer takes or writes the preview field. The update method no longer serializes it. The two response-shaping paths that strip it today no longer need to, and drop that code. The list projection that selects the whole listing row needs no change.

**API reference.** The README's publish example and the field list stop mentioning the preview field. The two older planning documents that describe it are historical and are left as they are.

**Backup script.** No change. The nightly script already compresses and uploads whatever the database is. The server doc's cost and size figures are updated after the reclaim.

**Rollback.** Redeploying old code against the new schema fails on insert, because the old model names the column. Rollback therefore means restoring the pre-deploy database snapshot as well as the old code. The nightly snapshot from the morning of the deploy is that restore point, and the server doc names it.

## Testing Decisions

**Seams.** Two existing seams and nothing new. The HTTP seam drives publish, update, list, and detail through supertest. The schema seam is the boot-schema drift test, which builds a fresh database and migrates the oldest schema fixture and compares the two shapes.

**What a good test looks like here.** It publishes or updates a listing through the route a client uses, then reads it back through the list or detail route and asserts on what a reader would see. It never opens the database to prove something the API can show. The one exception is the drift test, whose whole purpose is the schema shape.

**Coverage to write.**

- A publish without the preview field succeeds and the listing reads back with its name, description, and thumbnail URL.
- A publish that still sends the preview field succeeds, and the response and the list carry no trace of it.
- An update that still sends the preview field succeeds and changes nothing but the fields it names.
- The drift test's oldest-schema fixture keeps the column, and the migrated shape matches the fresh shape without it.
- The step reports a change on an old database and no change when run again.
- The existing "never exposes preview_data" list test is kept as the guard that the field is gone from responses.

**Fixtures.** The shared world payload helper drops the field. The raw-insert fixtures in the kind, event admin, and event placement tests drop the column from their insert statements and from the kind test's own table definition.

**Prior art.** The worlds tests for publish and list through supertest. The boot-schema tests for a step that changes an existing table, in particular the podium rebuild ordering test. The kind step for a step that adds a column and reports whether it did.

**Bar.** Coverage is measured, not guessed. The guard tests are checked to fail when the drop step is removed. No scenario is shaped so a mechanic cannot fire.

## Out of Scope

- Moving thumbnails or any other listing art. They already live on disk.
- Changing the publish body in any other way, including the top-level thumbnail field.
- Shrinking world content files or thumbnail files.
- Automating the vacuum.
- Removing the field from the two historical planning documents.

## Further Notes

The column was measured at 500 MB across 661 listings on 2026-09-04, against 2 MB for everything else in the database. The largest single value is a 25 MB GIF stored as 33 MB of base64 text, duplicating the file already on disk under the same listing.

The current client sends the field on every publish and update. The client half of this spec removes it, but the server must not depend on that, because the two deploy on different days.
