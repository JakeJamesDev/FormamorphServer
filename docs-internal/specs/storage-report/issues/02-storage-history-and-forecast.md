# 02: Storage history and forecast

Status: ready-for-human
Blocked by: 01
Recommended model: Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Reasoning effort: medium

Read-only work on the table from ticket 01. The mail report's per-day list is the pattern.

## What to build

An admin sees storage per day, downloads per day, and an estimate of the days until each disk is full. The report takes `?days=N`.

## Acceptance criteria

- [x] The report adds `days`, newest first, one entry per UTC day, today included. Each entry holds that day's stored values and `downloads`. Test: "lists one entry per UTC day, newest first, today included".
- [x] A day with no stored rows has null values, not zero. Test: "shows a day without rows as null values, not zero".
- [x] `downloads` is the per-day sum of `world_download_days`. Test: "sums downloads per day over all listings".
- [x] `days` defaults to 30 and has bounds. Spec session ruled 1 to 365 in a storage constant, not the mail report's 90. Tests: default 30, `days=0/-1/1.5/abc/""/366` give 400, `1` and `365` give 200.
- [x] The report adds `forecast` with `daysUntilFull` per filesystem: a straight line through the daily `used` values of the last 30 days. Test: "counts the days until full along the line", "fits a line through a sparse set of days".
- [x] `daysUntilFull` is null with fewer than 7 measured days, and null when use does not grow. Tests: "is null with fewer than 7 measured days", "is null when use is flat", "is null when use falls"; known answer 81 days. Both guards were mutated and the matching test failed.
- [x] Tests set the clock and the stored rows directly, like the mail report tests. `buildStorageReport(days, now)` takes the clock.
- [x] `docs-internal/server.md` describes the new report fields.

## Landed

**Not verified**
- None. Whole-number check on `days` uses `Number()` as the mail report does, so `1e2` and `0x10` pass.

**For you**
- Rulings from the spec session: `days` entries are `{ day, values, downloads }`, `forecast` is keyed by disk id, and the day bound is 1 to 365. The criterion line "same bounds as the mail report" is stale.
