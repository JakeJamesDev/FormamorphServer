# Spec: Hidden Gems (server)

Status: ready-for-agent

Client side: the Formamorph repo, `docs-internal/specs/hidden-gems/spec.md`. That spec has the full problem, the user stories, the Q-numbered rulings, and the app's placement rules. This spec is the server half, and it lands first.

## Problem Statement

The app wants to show three well-liked worlds with few downloads on page 1 of Community Creations. The server is the only place that can pick them: it holds every like and download, and the pick must be the same for every reader.

The server can't pick them fairly today. Likes started on 2026-08-03, but the `downloads` counter goes back to May 2025 and has no timestamps. An old world's all-time ratio is about 20 times lower than a new world's, so a ratio on the counter only finds new worlds.

## Solution

The server logs downloads per world per day, and rebuilds that log from backups for the time since 2026-09-06. Every 12 hours it scores worlds on likes and downloads from the last 60 days, and stores the top 3 eligible worlds as the current rotation. A world stays out of rotations for 7 days after it is picked. The catalog marks the current picks with `hidden_gem: true`. The app does the placement.

## User Stories

1. As the app, I want the current gems marked in the catalog I already fetch, so that I need no new request.
2. As the app, I want the catalog's `ETag` to change when the picks rotate, so that my conditional fetch gets the new picks.
3. As the app, I want at most 3 gems, so that the slots I have always fit.
4. As a reader, I want gems chosen on recent likes and downloads, so that a world isn't judged on downloads from before likes existed.
5. As a reader, I want a world with very few downloads not to win on luck, so that one like on two downloads doesn't beat a world liked by dozens.
6. As a reader, I want gems picked only from worlds I can see and download, so that a gem slot is never a dead end.
7. As a reader, I want the gems to rotate every 12 hours, so that I see new picks.
8. As a reader, I want a recent gem kept out for 7 days, so that the same worlds don't repeat.
9. As an author of a popular world, I understand my world won't be a gem, because it is above the download cutoff.
10. As a contest entrant, I want a hidden like count never to decide a gem, so that a gem slot never reveals my entry's rank.
11. As staff, I want a quarantined, unlisted, unapproved, pinned or Supporter-only world never flagged as a gem, so that gems follow the catalog's rules.
12. As staff, I want a world that changes state after its pick to lose the flag at once, so that I don't wait for the next rotation.
13. As staff or an author, I want the same flags a guest sees, so that a world I can see outside circulation never takes a gem slot in my view.
14. As the operator, I want every download logged by day from now on, so that later features can use recent activity.
15. As the operator, I want the log rebuilt from the backups we already have, so that the 60-day window works on day one.
16. As the operator, I want the rotation to survive restarts, so that a deploy doesn't reshuffle the gems early.
17. As the operator, I want the rotation to catch up after downtime, so that a stopped server doesn't leave a stale set for long.
18. As the operator, I want a rotation that finds no eligible world to clear the gems, so that an old set doesn't stay up for good.
19. As the operator, I want a failed rotation to log and retry, so that a bad run never stops the server.
20. As the operator, I want a catalog request to never compute scores, so that the gem feature adds no cost per request.
21. As a reader who opens a missing world, I want the same 404 as today, so that the download log never turns it into an error.

## Implementation Decisions

### Download log

- New table `world_download_days`: `world_id` (references `worlds`, cascades on delete), `day` (UTC `YYYY-MM-DD`), `count`. Primary key on `world_id` and `day`.
- `World.incrementDownloads` upserts today's bucket in the same transaction as the counter update, and only when the counter update changed a row. The content route calls it before it knows the world exists. Without this guard, the foreign key would turn that route's 404 into a 500.
- All three download paths (world content, Supporter content, dependency content) call it. Only world-content downloads can affect a pick (see Population). The other two are logged for later features.
- Day buckets, not one row per download. The score needs only days, and a bucket stores nothing about who downloaded.

### Backfill

- A one-off script takes an ordered list of backup files. It reads plain `.db` files and decompresses `.db.zst` files. It opens each one read-only.
- For each pair of backups in a row, each world's download difference is spread evenly over the UTC days after the earlier backup's day, up to and including the later backup's day. The remainder goes to the last day. A world missing from the earlier backup counts from 0. A negative difference counts as 0.
- An even spread matters because the backups are sparse. The nightly `db-<date>.db.zst` copies are pruned after 14 days, so before 2026-10-24 only the `pre-deploy-*.db` files remain, with gaps of up to 15 days. Putting a whole gap on its last day would keep those downloads in the window longer than the likes from the same days.
- It skips world ids that no longer exist in the live `worlds` table. The foreign key would reject them.
- The last backup in the list is the deploy's pre-deploy backup. The deploy skill takes it from the old server before the restart. Downloads between that backup and the new server's first start are lost. No download counts twice. The loss is a few minutes of downloads.
- The script adds to existing buckets for a day rather than replacing them, so it keeps what the live log already recorded.
- It refuses to run twice. It records its run in a new setting declared `internal: true` in the settings config, because `Setting` rejects keys that aren't declared.
- Production has backups from 2026-09-06 on, in `/srv/formamorph/app/backups`. Downloads before that date stay only in the counter.

### Population

`p`, `k` and the download cutoff are computed over the **population**: listings where all of these are true:

- `kind` is `world`;
- it is in circulation (the existing `inCirculationClause`);
- it is not pinned and not Supporter-only;
- its likes are not hidden from a public reader (the existing `likes_hidden` rule, evaluated for an anonymous reader).

Hidden contest likes therefore never enter `p`.

### Window

- The window is the 60 UTC days that end on the rotation's UTC day, that day included.
- Window downloads are the sum of the world's buckets whose `day` is in the window.
- Window likes are the rows in `world_likes` plus the rows in `anonymous_likes` whose `created_at` falls on a UTC day in the window.

### Score

- `p` = total window likes over total window downloads, across the population.
- `k` = the median window downloads across the population, by nearest rank on the ascending list. `k` is at least 1.
- `score = (likes + k·p) / (downloads + k)`.
- When the population's total window downloads is 0, the rotation picks no worlds.

### Eligibility

A world is eligible when all of these are true:

- it is in the population;
- its window downloads are strictly below the 75th percentile of the population's window downloads, by nearest rank on the ascending list;
- it has at least 3 window likes;
- it was not picked by a rotation whose time is less than 7 days before now. A world picked exactly 7 days ago is eligible again.

### Rotation

- New table `hidden_gem_rotations`: `id`, `rotated_at`. New table `hidden_gem_picks`: `rotation_id` (references the rotation, cascades on delete), `world_id` (references `worlds`, cascades on delete).
- `rotateHiddenGems(now)` makes a new rotation when there is none, or when the newest one is 12 hours old or older. It always inserts the rotation row, then up to 3 eligible worlds, highest score first. Ties break by world id, so a rotation is deterministic.
- A rotation with no eligible world has no picks. The newest rotation is then empty, so the catalog flags nothing until the next rotation.
- `rotated_at` is the time of the run. Rotations can drift up to an hour later than the 12-hour mark, because the runner is hourly. That is accepted.
- A new `start` function runs it once at boot and then through the `hourly` helper, like the existing sweepers. The age check makes the hourly run a no-op between rotations and catches up after downtime.
- The job wraps its work in try/catch and logs a failure, as the retention sweep does. `every()` does not catch, so a throw would otherwise crash the process. The next hourly tick retries.
- The same job prunes rotations older than 7 days, except the newest one.
- The constants (count 3, interval 12 h, cooldown 7 d, window 60 d, minimum 3 likes, 75th percentile) live in one config module.

### Catalog

- `GET /api/worlds` adds `hidden_gem` to every row. It is `true` only when all of these are true at read time:
  - the world has a pick in the newest rotation;
  - the world is still in the population (as defined above).
- The flag doesn't depend on the reader. Staff and authors also get catalog rows outside circulation, so the flag must check the population itself rather than rely on the reader's visibility filter.
- The server doesn't reorder rows for gems.

### Rulings from ticket 01

- **Q9.** Equal scores order by world id ascending, as a plain string compare.
- **Q10.** A rotation whose population has 0 window downloads still inserts an empty rotation row. The catalog flags nothing, and the 12-hour clock restarts.
- **Q11.** `hidden_gem` goes on every row `World.getAll` returns, including the author listing routes that reuse it. Non-world rows are always `false`. The single listing and content routes get no field.
- **Q12.** Pruning deletes rotations whose `rotated_at` is strictly older than now − 7 days, except the newest.
- **Q13.** A Like moved by a Claim keeps its original `created_at`, so it counts on the day it was first pressed.
- **Q18.** A backfill run with `--write` deletes every existing rotation, then calls `rotateHiddenGems(now)` in the same run. Every rotation before the backfill was picked on a near-empty log, and its picks would otherwise sit in cooldown for 7 days.
- **Q19.** When two backups fall on the same UTC day, their difference goes on that day.
- **Q20.** A backup's time comes from its file name. A nightly `db-<date>` file counts as 04:17 UTC on its date, the time of the nightly backup run. A name without a date, or a list out of time order, is refused before any write. The default run is dry and prints totals; `--write` writes and sets the `hidden_gem_backfill` marker. zstd input uses Node's built-in `zlib`.
- **Q17.** The world-content route returns 500 for a missing id today, because the not-found error from `getContent` maps to 500. Ticket 01 makes it return 404 before the download is counted, like the other two content routes. The bucket guard in `incrementDownloads` stays as well.

## Testing Decisions

- A good test drives `GET /api/worlds`, the download routes, the backfill script, and `rotateHiddenGems(now)` with a set clock, and checks the catalog response. It doesn't read the new tables directly, and it doesn't compute a score by hand.
- Fixtures are built so the expected pick is plain without arithmetic. For example, one world has many likes and few downloads, and another has few likes and many downloads.
- Prior art: `tests/worlds.test.js` for catalog shape, `tests/hiddenLikes.test.js` for the contest hidden-likes rule, and `tests/anonymousLikes.test.js` for setting up both kinds of like.
- Cases:
  - downloads through the world-content route count toward the window: a world that was eligible becomes ineligible after it passes the download cutoff;
  - a world-content request for a missing id still returns 404;
  - a well-liked world with few downloads is picked, and a popular one is not;
  - likes and downloads outside the window don't count;
  - a world with fewer than 3 window likes, or downloads at or above the cutoff, is not picked;
  - pinned, Supporter-only, quarantined, unlisted, unapproved and non-world listings are not picked;
  - a contest entry with hidden likes is not picked;
  - a second rotation before 12 hours changes nothing, and one at 12 hours makes a new rotation;
  - a world picked less than 7 days ago is not picked again, and is eligible at 7 days;
  - fewer than 3 eligible worlds gives fewer flags;
  - a rotation with no eligible world clears every flag;
  - a picked world that is then quarantined, unlisted, pinned or made Supporter-only loses its flag with no rotation, for a guest, for staff and for its author;
  - the catalog `ETag` changes after a rotation that changes the picks;
  - the backfill, run on fixture backups into a fixture live database, gives the expected pick outcome. A world whose downloads all came before the window is picked as a low-download world. A deleted world's backup rows are skipped without error. A second run is refused.
  - a rotation that throws is logged, and the next run succeeds.

## Out of Scope

- Any placement or ordering of gems. That is the app's work.
- A staff switch that turns hidden gems off for everyone.
- A `gems` query param. The app turns gems off on the device.
- Using the download log for any other sort or chart.
- Download history before 2026-09-06.

## Further Notes

- Measured on 2026-11-07 against production, with the 2026-09-06 backup as the baseline: 661 public worlds, 106 eligible, `p` ≈ 0.023, median window downloads 59, 75th percentile 135.
- Deploy: three new tables, so the deploy skill's backup runs before the schema step. Run the backfill right after the deploy, with that backup last in its list.
