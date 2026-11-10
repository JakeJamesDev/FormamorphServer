# 01: Disk and directory report

Status: ready-for-agent
Blocked by: None (can start immediately)
Recommended model: Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Reasoning effort: high

Follows the mail health job and the mail report closely. The new parts are the schema step and an asynchronous directory walk.

## What to build

An admin calls `GET /api/storage/report` and sees how full each disk is, how much space each upload directory, the database, and the local backups use, and whether a vacuum fits. The server measures the directories at boot and every hour and keeps the numbers per UTC day.

## Acceptance criteria

- [ ] A schema step adds `storage_days` in long format: `day`, `name`, `bytes`, `files`, primary key `(day, name)`.
- [ ] The storage check job runs at boot and on the shared hourly timer. It never throws, and a failed walk of one directory does not stop the rest.
- [ ] The job reads each filesystem under the storage root and the data directory. Two paths on one filesystem report once.
- [ ] The job measures bytes and file count for worlds, thumbnails, pending, avatars, event posters, supporter-private, the database with its WAL, and the local backups directory. The walk does not block requests.
- [ ] A second run on one UTC day replaces that day's rows.
- [ ] `GET /api/storage/report` is admin only. It returns `disks` (`total`, `used`, `free`, `usedFraction`, read at request time), `parts` (`bytes`, `files`, `measuredAt`), and `vacuumFits`.
- [ ] `vacuumFits` is true only when free space is at least the database size. Tests cover both sides of the limit.
- [ ] Route tests point the storage root at a scratch directory with real files and check the bytes and counts against those files. Only the disk totals are injected.
- [ ] The ticket states the server's Node version in its `## Landed` section. `fs.statfs` needs 18.15 or later; if the server is older, stop and ask.
- [ ] `docs-internal/server.md` describes the report route and the hourly job. `CONTEXT.md` gains a **Storage report** entry.
