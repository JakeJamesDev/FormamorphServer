# Spec: Storage Report

Status: draft
Spec session: storage-report — spec
Status note: Written 2026-11-10 from a design discussion. Not reviewed. The R2 source is the Cloudflare API, proven by ticket 04 (see Open Items).

## Problem Statement

Admins cannot see how full the server disk is without an SSH session.

- The Admin Panel shows Formamorph AI spend and mail health. It shows nothing about storage.
- Nobody gets a warning before the disk fills. A full disk stops uploads and can corrupt a database write.
- A `VACUUM` can need free disk of twice the database file. Nothing tells an admin whether one fits.
- R2 went over its 10 GB free tier once. The bucket sizes are visible only in the Cloudflare dashboard.
- There is no history, so nobody can tell how fast storage grows.

## Solution

The server measures storage every hour and keeps one set of numbers per UTC day. An admin-only report returns the current state and the history. The server mails the admins when the disk passes 80% and 90%.

The report has four parts:

| Part | Content |
|---|---|
| 💽 Disk | Total, used, and free bytes for each filesystem the server writes to |
| 📁 Directories | Bytes and file count for each upload directory, the database, and local backups |
| ☁️ R2 | Size and object count of both buckets, against the free tier |
| 📈 History | The same numbers per day, plus downloads per day |

The client shows the report in the Admin Panel beside Formamorph AI and Emails.

## User Stories

1. As an admin, I want to see how full the disk is, so that I can act before it fills.
2. As an admin, I want to see which directory uses the most space, so that I know what to clean up.
3. As an admin, I want to see the database size, so that I know when a vacuum is worth it.
4. As an admin, I want to know whether a vacuum fits in the free space, so that I don't start one that fails.
5. As an admin, I want to see how much space the local backups use, so that I can check the 14-day prune works.
6. As an admin, I want a mail when the disk reaches 80%, so that I have time to plan.
7. As an admin, I want a second mail at 90%, so that I know it is urgent.
8. As an admin, I want one mail per level, not one per hour, so that the alert stays meaningful.
9. As an admin, I want the alert to arm again after the disk drops below the level, so that the next rise is reported.
10. As an admin, I want to see disk use per day, so that I can see the growth rate.
11. As an admin, I want an estimate of the days until the disk is full, so that I can plan an upgrade.
12. As an admin, I want no estimate when there is too little history or no growth, so that I am not misled.
13. As an admin, I want to see each R2 bucket's size against the 10 GB free tier, so that I see a cost before the invoice.
14. As an admin, I want to see when the R2 numbers were last read, so that I can tell a stale number from a current one.
15. As an admin, I want the report to work when R2 is not configured, so that a missing token does not hide the disk numbers.
16. As an admin, I want downloads per day beside the storage history, so that I can relate traffic to growth.
17. As an admin, I want a day with no measurement to show as empty, not zero, so that a gap does not look like a drop.

## Implementation Decisions

Rulings from the discussion:

| # | Ruling |
|---|---|
| Q1 | The base slice is disk fullness, per-directory sizes, daily history, and the existing download counts. |
| Q2 | Disk-full alerts are in scope. |
| Q3 | R2 bucket sizes are in scope. |
| Q4 | Upload and download byte counters are out of scope. |
| Q5 | Hetzner bandwidth is out of scope. |
| Q6 | The server measures hourly. |
| Q7 | R2 sizes come from the Cloudflare GraphQL Analytics API. The nightly backup script is the fallback if the token test fails. |

### Measurement

- **Storage check job.** One hourly job, started beside the mail health monitor. It also runs once at boot. It never throws.
- **Disk.** `fs.statfs` on the storage root and the data directory. Two paths on one filesystem report once; the job compares `fs.stat` device ids.
- **Directories.** The job walks each directory in the paths module: worlds, thumbnails, pending, avatars, event posters, and supporter-private. It also measures the database file with its WAL, and the local backups directory. The walk is asynchronous so it does not block requests.
- **R2.** One GraphQL query reads `r2StorageAdaptiveGroups` for both buckets and takes the newest row of each. Size is `payloadSize + metadataSize`. A failed read keeps the last good value and its timestamp. With no token, the job skips R2.
- **Config.** One new env key holds the Cloudflare analytics token. The account id and bucket names come from the R2 keys already in the server env. The alert levels and the R2 free tier are constants in a config module.

### Storage

- **One new table, `storage_days`.** Long format: `day`, `name`, `bytes`, `files`, `measured_at`, with primary key `(day, name)`.
- Each hourly run replaces the rows for the current UTC day. The last run of a day is that day's value. A failed walk of one directory writes nothing for that name, so its last row stays. A missing directory is a failed walk. A run that cannot read one disk role stores no disk row and sends no alert.
- Names: `disk:<id>:total`, `disk:<id>:used`, `worlds`, `thumbnails`, `pending`, `avatars`, `event-posters`, `supporter-private`, `database`, `backups`, and `r2:<bucket>`.
- **Disk id.** The roles on that filesystem, joined with `+` in the fixed order storage, data, app. One filesystem for all three is `storage+data+app`. The app role is the filesystem of the local backups directory.
- The backups directory constant moves into the paths module.
- A new directory needs no schema step. It gets a new name.
- Rows are kept forever. The table grows by about 15 rows a day.
- The alert state lives in a setting, as the mail health job does. The last R2 read needs no setting; the stored rows hold it.

### Alerts

- Levels: 80% and 90% of a filesystem's total. A filesystem reaches a level when its `usedFraction` is at or above it.
- The report's `alertLevels` is the level constants, the same on every disk. The alert state is not in the report.
- The job sends one mail when a filesystem reaches a level it had not reached. Going from under 80% to over 90% in one hour sends only the 90% mail.
- Dropping below a level arms that level again.
- The alert state is stored before the mail goes out, so a failed mail never repeats.
- R2 has no alert in this spec. The report shows it against the free tier.

### Report

- **`GET /api/storage/report?days=N`**, admin only. The path follows `/api/mail/report`. `days` defaults to 30 and accepts whole numbers from 1 to 365. Anything else is a 400.
- Shape:
  - `disks`: an array. Each entry has `id`, `paths`, `total`, `used`, `free`, `usedFraction`, and `alertLevels`. Read live at request time.
  - `parts`: an object keyed by name. Each value has `bytes`, `files`, and `measuredAt`, from the newest stored row for that name on any day. Every known name is present; a name never measured is null.
  - `vacuumFits`: true when free space on the database's filesystem is at least twice the database file, WAL not included. SQLite states that a vacuum can need that much.
  - `r2`: `freeTierBytes` and `buckets`, keyed by bucket name. Each bucket has `bytes`, `objects`, and `checkedAt`, or is null when it was never read. `checkedAt` is the time of the newest stored row. `r2` is null when the token, the account id, or a bucket name is missing. The free tier is account-wide.
  - `forecast`: an object keyed by disk id. Each value has `daysUntilFull`, a whole number rounded down, or null.
  - `days`: newest first, one entry per UTC day with `day`, `values`, and `downloads`. `values` is keyed by stored name, disk and R2 rows included, each `{ bytes, files }` or null when that day has no row. `downloads` is 0 on a day with none.
- **Forecast.** A least-squares line through the daily `used` values of the last 30 days, whatever `days` is. Full is where the line reaches the current total. Null with fewer than 7 measured days, or when use does not grow.
- **Downloads.** The per-day sum of `world_download_days`.

### Client

- A Storage tab in the Admin Panel, visible to admins, beside Formamorph AI and Emails.
- A disk meter with the 80% and 90% marks, a table of parts, the R2 meters, and a history chart.
- The client spec settles layout and copy when the server work is deployed.

## Testing Decisions

A good test sends a request or runs the job, then checks what an admin or the mailbox sees. It does not check internal state. Each guard is proved by reinstating its bug and watching the test fail.

Two seams:

1. **`GET /api/storage/report` over supertest.** Prior art: the mail report tests. The storage root points at a scratch directory with known files. Cases: directory bytes and file counts match the files; non-admins are refused; `days` bounds; a day with no rows is null, not zero; `vacuumFits` on both sides of the limit; the forecast is null under 7 days and with flat use; downloads sum per day; `r2` is null with no token.
2. **The storage check job, called directly.** Prior art: the mail health tests. The disk reading and the Cloudflare fetch are injected, because a test cannot fill a real disk. Cases: each level alerts once; a jump past both levels sends one mail; a drop arms the level again; a failed R2 read keeps the last value; a second run on one day replaces the rows; a failed walk does not throw.

The tests use real files for the directory walk. Only the disk totals and the network are injected.

## Out of Scope

- Bytes uploaded and bytes served per day.
- Server-wide bandwidth from Hetzner.
- Storage per user or per listing.
- Automatic cleanup or automatic vacuum.
- An R2 alert mail.

## Open Items

- **R2 source ruling (ticket 04, 2026-11-10): Cloudflare API.** A token with only **Account Analytics: Read** runs `r2StorageAdaptiveGroups` (HTTP 200, no errors). Rows arrive about every 30 minutes, and the newest was under 1 hour old for both buckets. `payloadSize` matched `rclone size` to the byte; `metadataSize` is a small extra that the report adds. The rate limit stays unmeasured; one query an hour is far below any limit. The fallback below is not needed.
- **Query shape that worked.** `viewer.accounts(filter:{accountTag}).r2StorageAdaptiveGroups(limit:10, orderBy:[datetime_DESC], filter:{datetime_geq, datetime_leq, bucketName})`, selecting `dimensions{datetime bucketName}` and `max{payloadSize metadataSize objectCount}`. Use a 7-day window and take the first row.
- **Fallback (unused).** The nightly backup script writes `rclone size --json` for both buckets to a file in the data directory. The job reads that file. The report shape does not change.
- **Server Node version.** `fs.statfs` needs Node 18.15 or later. Confirm on the server before the first ticket.

## Further Notes

- Server only until the client tab ships. An old client never calls the route.
- The new env key goes in the server env file by hand before the R2 ticket deploys.
- One schema step adds the table. The deploy takes a database backup, as for any schema step.
