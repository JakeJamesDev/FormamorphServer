# Spec: Timed suspensions

Status: ready-for-agent
Spec session: timed-suspensions — spec

Client side: the formamorph repo, `docs-internal/specs/timed-suspensions/spec.md`.

## Problem Statement

A suspension today is a toggle. Staff suspend an account, and it stays suspended until somebody remembers to activate it again. Most suspensions are warnings meant to last a few days. Staff have to track each end date by hand, and a forgotten one keeps the account locked indefinitely. Quarantine already solves the same problem for listings with a deadline and a sweep.

## Solution

A suspension gets an optional end time. Staff choose a length in whole days, from 1 to 90, or no end. When the end time passes, the server lifts the suspension by itself, returns the account to Normal, and records the lift in the audit log. The suspended account sees the end time when a write is refused. Suspending an account that is already suspended replaces its end time.

## User Stories

1. As a staff member, I want to suspend an account for a set number of days, so that I do not have to remember to lift it.
2. As a staff member, I want to suspend an account with no end, so that serious cases stay suspended until staff decide otherwise.
3. As a mod, I want the same no-end option that an admin has, so that I can handle a serious case without waiting for an admin.
4. As a staff member, I want the length bounded to 1–90 days, so that a typo cannot set a suspension for years.
5. As a staff member, I want a refused length to name the allowed range, so that I can correct it at once.
6. As a staff member, I want to suspend an account that is already suspended and set a new end, so that I can lengthen or shorten a suspension in one step.
7. As a staff member, I want the new end to replace the old one, so that there is only one end time to reason about.
8. As a staff member, I want to change a timed suspension to no end, and the reverse, so that I can escalate or relax a case.
9. As a staff member, I want Activate to clear the end time, so that an early lift leaves nothing behind.
10. As a staff member, I want the admin user list to carry each account's end time, so that the panel can show when each suspension ends.
11. As a staff member, I want the status update response to carry the end time, so that the panel can show it without a refetch.
12. As a staff member, I want every suspension entry in the audit log to state its end, so that I can see what length was chosen and when it changed.
13. As a staff member, I want an expired suspension to appear in the audit log as lifted by the server, so that the history explains why the account is active again.
14. As a staff member, I want that entry to name no staff member, so that the log does not credit somebody who did nothing.
15. As a suspended user, I want a refused write to tell me when my suspension ends, so that I know how long to wait.
16. As a suspended user with no end time, I want the refusal to say only that I am suspended, so that it does not suggest an end that does not exist.
17. As a suspended user, I want access back as soon as my end time passes, so that a server outage or a missed sweep does not extend my suspension.
18. As a user whose suspension ended, I want my profile shown publicly again, so that my work is visible again.
19. As a user whose suspension ended, I want my account to return to Normal, so that I am treated like any other account.
20. As a user whose suspension ended, I want no extra message in my inbox, so that the end of a warning is quiet.
21. As a staff member, I want accounts suspended before this change to stay suspended with no end, so that nothing is lifted without review.
22. As a staff member, I want the staff ladder to apply to every suspension change, so that the end time cannot be used to reach an account I may not moderate.
23. As an older app build, I want a suspend request without a length to behave as it does today, so that a mod on an older build gets the same result.

## Implementation Decisions

- **Schema.** The users table gains a nullable `suspended_until` column (ISO instant). Null with status `suspended` means no end. Null otherwise means nothing. A schema step adds the column; there is no backfill (Q8).
- **Status contract.** `PUT /api/users/:id/status` accepts an optional `days` field next to `status`. With `status: 'suspended'`:
  - `days` an integer from 1 to 90 sets `suspended_until` to now plus that many days.
  - `days` omitted or `null` sets no end. Omitted keeps older builds' Suspend button meaning what it means today.
  - Any other `days` value is a 400 naming the range, with the same wording style as quarantine.
  - The UI default of 7 days lives in the client, the same as quarantine's picker default.
- `days` with any status other than `suspended` is a 400. Any status other than `suspended` clears `suspended_until`.
- **Re-suspend (Q4).** Suspending an account that is already suspended is now a real change when the end differs. It replaces `suspended_until` and records a `user_suspended` entry. It does not revoke sessions again; the account has none that can write.
- **Audit (Q6, Q12).** Every `user_suspended` entry carries a snippet stating the end: the instant, or that it has no end. A new `suspension_expired` action records each lift by the sweep with a null actor, the way `quarantine_expired` does. It joins the audit action list and the audit filters.
- **Sweep.** A `sweepSuspensions(now)` module, shaped like `sweepQuarantine`: find every suspended account whose `suspended_until` has passed, set status `normal`, clear the end, and record `suspension_expired`. It never throws. It runs at boot and on the shared hourly timer.
- **Lazy lift.** `authenticate` lifts an expired suspension for the account it is checking before it applies the suspended gate, through the same model call the sweep uses. A missed tick or a server that was down over the end can then never refuse a write past the deadline. The public profile and username lookups read status after the same check, so they never hide a profile past its end.
- **Return status (Q10).** A lift always sets `normal`. The status before the suspension is not stored.
- **No notice on lift (Q5).** The sweep sends no message.
- **Refusal text (Q3).** The 403 from the suspended gate carries `suspendedUntil` (the instant or null). Its `error` text names the end in UTC when there is one, and keeps today's text when there is none.
- **Read shapes.** The admin user list, the status update response, and the signed-in account's own record include `suspended_until`. Public profile reads do not.
- **Staff ladder (Q9).** `canModerate` already gates the route. Choosing no end needs no extra role.
- **Glossary.** Add **Suspension** to `CONTEXT.md`: an account's write access withdrawn by staff, with an optional end time the server enforces.

## Testing Decisions

- Tests drive external behavior only: HTTP through supertest against the test app, and the sweep through its exported function with an injected `now`. No test reads the column directly when a route can show the same fact.
- **Status route.** Suspend with `days` sets an end about that many days out; omitted and `null` set none; out-of-range, fractional, and string values are 400s; `days` with `normal` is a 400; re-suspend replaces the end and logs; Activate clears the end; the staff ladder still refuses a peer.
- **Gate.** A write from an account with a future end is refused with `suspendedUntil` and the date in the text; with no end, the text is unchanged; with a past end, the write succeeds and the account reads Normal afterwards. That last case proves the lazy lift and must fail when the lift is removed.
- **Sweep.** With an injected clock: an expired account is lifted and logged with no actor; a future one and a no-end one are left alone; one bad row does not stop the rest.
- **Audit.** `user_suspended` snippets carry the end; `suspension_expired` is accepted by the log and its filter.
- Prior art: `tests/quarantine.test.js` (deadline, sweep with injected time), `tests/adminUsers.test.js` (status route and ladder), `tests/audit.test.js`.

## Out of Scope

- Hour-level durations (Q2).
- A message to the user when a suspension lifts (Q5).
- Restoring Flagged or any earlier status after a lift (Q10).
- Ending suspensions that exist before this ships (Q8).
- Any change to what a suspended account may or may not do.

## Further Notes

- Rulings Q1–Q10 come from the grill on 2026-10-17. Q1: no-end option kept. Q2: days, 1–90, default 7. Q3: end shown in the refusal and the notice. Q4: re-suspend replaces the end. Q5: no lift message. Q6: server-actor audit entry. Q7: the Users table shows the end. Q8: no backfill. Q9: any staff who can suspend may choose no end. Q10: lift returns to Normal.
- The client ticket depends on the new fields and on `suspension_expired`; the server lands first.
