# 03: Disk-full alerts

Status: ready-for-human
Blocked by: 01
Recommended model: Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Reasoning effort: medium

The mail health alerts are the pattern: one mail per condition, state in a setting, re-arm when the condition clears.

## What to build

The admins get one mail when a disk reaches 80% and one when it reaches 90%. The storage check job from ticket 01 sends them.

## Acceptance criteria

- [x] The levels are constants in a config module: 80% and 90% of a filesystem's total. `ALERT_LEVELS` in `src/config/storage.js`.
- [x] The job sends one mail when a filesystem reaches a level it had not reached. The next hourly run at the same level sends nothing. Tests "sends one mail when a disk reaches 80%…" and "sends the 90% mail next, once".
- [x] A rise from under 80% to over 90% in one run sends only the 90% mail. Test "sends only the 90% mail on a rise…".
- [x] A drop below a level arms that level again, and the next rise sends a mail. Tests "arms a level again…" and "arms only the 90% level on a drop from 95% to 85%".
- [x] The alert state is stored before the mail goes out, so a failed mail does not repeat. Test reads the stored state inside the mail send; it went red with the order swapped.
- [x] The mail names the filesystem, the used percent, and the free space. Test "names the filesystem, the used percent and the free space in the mail".
- [x] The report's `disks` entries gain `alertLevels`. Test "lists the level constants on every disk" and the updated disks test in `tests/storageReport.test.js`.
- [x] Tests call the job with an injected disk reading and check the mails sent, like the mail health tests. `tests/storageAlerts.test.js`, 9 tests.
- [x] `docs-internal/server.md` describes the alerts and where to change the levels. "Disk-full alerts" bullet under Storage report.

## Landed

**Not verified**
- A disk id that changes between runs, such as `storage+data+app` becoming `storage+app` when one role's `stat` fails for one run. The state is keyed by id, so the new id mails again at a level it already reached. This comes from ticket 01's id grouping, which the spec session said to leave as it is. No test covers it. Stale ids are never pruned from the setting.
- The tests use one disk. No test has two disks in one run.

**For you**
- Check that the real alert mail reads well in the admin inbox and at `STAFF_ALERT_EMAIL`: subject "Disk <id> is 80% full", body with paths, used percent and free space.
