# 02: Suspension sweep

Status: ready-for-agent
Blocked by: 01
Recommended model: Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Reasoning effort: medium

Mirrors the quarantine sweep closely, so this is pattern work.

## What to build

The server lifts every expired suspension by itself at boot and every hour, even when the account never signs in. Each lift appears in the audit log as done by the server.

## Acceptance criteria

- [ ] `sweepSuspensions(now)` finds every expired suspended account and lifts each through `liftExpiredSuspension(row, now)`, the util from ticket 01 that also writes the `suspension_expired` entry. Never call the bare model lift, which logs nothing. The sweep never throws, and one bad row does not stop the rest.
- [ ] The sweep runs at boot and on the shared hourly timer.
- [ ] Ticket 01 added `suspension_expired` to the action list, and the audit filter reads that list. Add a test that proves the filter returns sweep lifts; change the filter only if that test fails.
- [ ] Future-end and no-end suspensions are left alone.
- [ ] `CONTEXT.md` gains a **Suspension** entry, and the **Audit log** entry names `suspension_expired`.
- [ ] Tests call the sweep with an injected clock, like the quarantine sweep tests.
