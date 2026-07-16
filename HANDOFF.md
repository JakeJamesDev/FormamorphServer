# Handoff: characters & dictionaries in the workshop

This adds a `kind` to published items so the workshop can host **characters** and **dictionaries**
alongside worlds, plus a test suite and configurable data paths. It's meant for `workshop.fierylion.com`.

**The short version:** existing clients see exactly what they see today, the migration runs itself on boot,
and nothing about worlds changed. Details and evidence below.

---

## The compatibility guarantee

This is the part worth scrutinising, since your deployed clients don't know kinds exist.

`kind` **defaults to `world` on every list endpoint.** A client that sends no `kind` gets worlds only and
can never be handed a character it can't render. That default is enforced in one shared place
(`utils/kindQuery.js`) rather than repeated per endpoint, so one route can't quietly drift.

The evidence that worlds still behave: **31 characterization tests (`tests/worlds.test.js`) were written
against the current behaviour *before* `kind` existed**, and they still pass untouched. They cover worlds
CRUD, auth gating, ownership (including admin override), validation, pagination, search, comments, spoiler,
and thumbnails. If this diff had changed anything about worlds, those tests would say so.

We also verified it accidentally from the other direction: our client sends `?kind=all` and, pointed at
your *current* production, it degrades gracefully — the unknown param is ignored, worlds come back, the new
tabs are simply empty.

## What to look at first

| File | Why |
|---|---|
| `src/config/kinds.js` | The kinds, the `world` default, and the per-kind rules |
| `src/utils/kindQuery.js` | The one place `?kind` is read — the compatibility contract |
| `src/utils/addKindColumn.js` | The migration |
| `src/models/World.js` | `getAll` gained a `kind` filter; `getByAuthor` gained `kind` + a row ceiling |

## Deploying

**Nothing to do.** `server.js` runs the migration at startup. It's additive (`ALTER TABLE worlds ADD COLUMN
kind TEXT NOT NULL DEFAULT 'world'`), idempotent, and a no-op on every boot after the first. Existing rows
classify themselves as `world` via the column default — no backfill, nothing to undo.

It boots itself because the failure mode is severe: every list query filters on `worlds.kind`, so new code
against an unmigrated database returns `500` from the whole catalog (`no such column: w.kind`). We tested
that on a copy of the old schema — it fails as described, and self-migrating on boot makes the deploy order
irrelevant. `npm run migrate-kind` still exists if you'd rather run it ahead of time.

Verified against a database on the old schema with real rows: data intact, download counts preserved,
existing rows classified `world`, second run a no-op.

**Rollback** is just redeploying the old code. The extra column is additive and the old code never
references it, so a rolled-back server ignores it. Any characters or dictionaries published in the interim
would become invisible (the old code has no `kind` filter, so they'd appear as worlds — worth knowing).

## What changed beyond `kind`

**Configurable paths** (`src/config/paths.js`). The DB directory, storage root, backups, and snapshots are
each env-overridable, with defaults identical to the previous hard-coded values — an install that sets
nothing is unchanged. This was needed to point tests at scratch directories, but it's independently useful:
the current default puts user uploads **inside the source tree** (`src/storage/`), where a clean checkout or
redeploy can wipe them. `STORAGE_ROOT` gives you a way out without changing behaviour.

Those paths had drifted into **five separate copies** (fileStorage, the thumbnails route, deleteUser,
backupRestore, worldSnapshot), each re-deriving the same directories. They now share one module. We checked
that all nine derivations resolved identically before consolidating, so it's a faithful merge, not a change.

**A test suite** — vitest + supertest, 85 tests, no fixtures. Route tests drive the real Express app against
an in-memory database. `npm test`. This adds three devDependencies; if the vitest toolchain isn't something
you want in the repo, say so and we'll port them to `node:test` (its coverage works fine on Node 24 — we
checked).

**Two fixes found along the way**, both pre-existing:

- `getByAuthor` inherited `getAll`'s default `limit = 10`, so `/users/me/worlds` silently returned only your
  first ten. An eleventh world couldn't be offered as an update target — absent, with nothing saying so.
  It now returns everything, and reports `total` so a truncated response is detectable.
- `routes/thumbnails.js` re-derived the thumbnails path instead of importing the one `fileStorage.js`
  already exported — two sources of truth that could drift apart.

## Known gaps

- `SERVER_PLANS.md` still describes MongoDB/Mongoose and calls this "Exotic Dangerous". It was stale before
  this work; we left it alone rather than rewrite your docs.
- `src/utils` (backup/snapshot/deleteUser scripts) is at ~12% coverage — untested, and out of scope here.
- The author listing endpoints have no `?page`/`?limit`. The row ceiling (1000) makes it unnecessary for
  now, and `total` reveals it if it ever bites.
