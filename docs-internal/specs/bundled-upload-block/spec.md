# Spec: Bundled upload block

Status: ready-for-agent

Client side: the formamorph repo, `docs-internal/specs/bundled-upload-block/spec.md`. It owns the fingerprint list and the generator script.

## Problem Statement

Players keep publishing the app's bundled worlds and its default Avatar without changing them. Every player already has these, so the listings add nothing. Staff remove them by hand. The new client refuses them before upload, but old clients do not, and a duplicated bundled world gets a new id that the client check cannot recognize.

## Solution

The publish route refuses a world listing whose content matches a bundled world, and an Avatar listing whose file is the default Avatar. The refusal is a 400 with a message that tells the player what to change:

- World: "This is a bundled world. Edit it to make it your own, then publish."
- Avatar: "This is the default avatar. Upload your own VRM."

## User Stories

1. As a player on any client version, I want an unmodified bundled world refused with a clear message, so that I know to edit it first.
2. As a player who duplicated or re-imported a bundled world, I want the copy refused, so that a new id is not a way around the rule.
3. As a player who publishes a bundled world from an older version, I want it refused, so that the rule does not depend on the version.
4. As a player who edited a bundled world's text, I want the publish accepted, so that real work reaches the catalog.
5. As a player, I want every world I wrote accepted exactly as today, so that the check never blocks my own work.
6. As a player, I want the default Avatar refused, whichever build's file I upload, so that the rule is the same for everyone.
7. As a player, I want any other Avatar to reach the license gate as today, so that the check adds nothing to a normal upload.
8. As a staff member, I want no new unmodified bundled listings, so that I stop removing them by hand.
9. As a developer, I want the list of known fingerprints in one generated file, so that a release updates it by copying one file.
10. As a developer, I want the server fingerprint to match the client's exactly, so that the two sides never disagree about a world.
11. As a developer, I want live listings untouched, so that the change needs no migration.

## Implementation Decisions

- **Scope**: the `world` and `model` kinds only, on publish. Updates to an existing listing are checked the same way as a new publish.
- **World check**: fingerprint the published content and look it up in the world fingerprint set. On a match, refuse before storing anything.
- **Fingerprint function**: collect every string value of 40 or more characters from the content, at any depth, except values under a `code` key. Collapse each whitespace run to one space and trim. Remove duplicates, sort, join with a newline, and take a lowercase hex SHA-256. It must give the same result as the client's function.
- **Avatar check**: the route already decodes the VRM bytes to read the license. Take the SHA-256 of those same bytes and look it up in the Avatar hash set, before the license gate.
- **Fingerprint list**: a generated JSON file with a world fingerprint list and an Avatar hash list. It is copied in from the client repo at each release. The server loads it once at start into two sets.
- **Cost**: one pass over the world content per publish, the same order as the existing size check. No database change.
- **Existing listings**: untouched.

## Testing Decisions

A good test publishes through the real route and asserts on the status and the message. It never reaches into the fingerprint internals.

- **Publish route (world)**: a bundled world from the list is refused with a 400 and the world message, and no row is stored. The same world with one long text value changed is accepted. An ordinary world is accepted. Prior art: the world route tests.
- **Publish route (Avatar)**: the default Avatar bytes are refused with a 400 and the Avatar message. Another permissive VRM is accepted as today. Prior art: the model kind tests and the GLB fixture.
- **Shared test vector**: the same small world and expected fingerprint as the client's test, so both implementations are pinned to one answer.
- The route tests load a test fingerprint list built from a small fixture world, not copied bundled world text.

## Out of Scope

- Entities and dictionaries copied from bundled worlds.
- Similarity matching.
- Hiding or reviewing live listings.
- Generating the fingerprint list on the server.
