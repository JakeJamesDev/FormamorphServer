# 03: Disk-full alerts

Status: ready-for-agent
Blocked by: 01
Recommended model: Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Reasoning effort: medium

The mail health alerts are the pattern: one mail per condition, state in a setting, re-arm when the condition clears.

## What to build

The admins get one mail when a disk reaches 80% and one when it reaches 90%. The storage check job from ticket 01 sends them.

## Acceptance criteria

- [ ] The levels are constants in a config module: 80% and 90% of a filesystem's total.
- [ ] The job sends one mail when a filesystem reaches a level it had not reached. The next hourly run at the same level sends nothing.
- [ ] A rise from under 80% to over 90% in one run sends only the 90% mail.
- [ ] A drop below a level arms that level again, and the next rise sends a mail.
- [ ] The alert state is stored before the mail goes out, so a failed mail does not repeat.
- [ ] The mail names the filesystem, the used percent, and the free space.
- [ ] The report's `disks` entries gain `alertLevels`.
- [ ] Tests call the job with an injected disk reading and check the mails sent, like the mail health tests.
- [ ] `docs-internal/server.md` describes the alerts and where to change the levels.
