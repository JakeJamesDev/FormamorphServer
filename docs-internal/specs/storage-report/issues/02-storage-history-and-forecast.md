# 02: Storage history and forecast

Status: ready-for-agent
Blocked by: 01
Recommended model: Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Reasoning effort: medium

Read-only work on the table from ticket 01. The mail report's per-day list is the pattern.

## What to build

An admin sees storage per day, downloads per day, and an estimate of the days until each disk is full. The report takes `?days=N`.

## Acceptance criteria

- [ ] The report adds `days`, newest first, one entry per UTC day, today included. Each entry holds that day's stored values and `downloads`.
- [ ] A day with no stored rows has null values, not zero.
- [ ] `downloads` is the per-day sum of `world_download_days`.
- [ ] `days` defaults to 30 and has the same bounds as the mail report. Tests cover the bounds.
- [ ] The report adds `forecast` with `daysUntilFull` per filesystem: a straight line through the daily `used` values of the last 30 days.
- [ ] `daysUntilFull` is null with fewer than 7 measured days, and null when use does not grow. Tests cover both, and a growing case with a known answer.
- [ ] Tests set the clock and the stored rows directly, like the mail report tests.
- [ ] `docs-internal/server.md` describes the new report fields.
