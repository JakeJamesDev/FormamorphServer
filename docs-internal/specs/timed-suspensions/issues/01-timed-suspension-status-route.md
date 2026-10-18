# 01: Timed suspension on the status route

Status: ready-for-human
Blocked by: None (can start immediately)
Recommended model: Claude Opus 5.5 (`claude-opus-5-5`)
Reasoning effort: high

Touches the auth gate every write passes through, so the lazy lift must be exact.

## What to build

Staff can suspend an account for 1–90 days or with no end. Suspending a suspended account replaces its end. A suspended account's refused write names the end. Once the end passes, the account's next request lifts the suspension and the write succeeds. See the spec's Implementation Decisions for the contract.

## Acceptance criteria

- [ ] A schema step adds a nullable `suspended_until` to users, with no backfill.
- [ ] The status route accepts `days` (integer 1–90, `null`, or omitted) with `suspended`. Omitted and `null` set no end. Other values, and `days` with any other status, are 400s naming the rule.
- [ ] Any status other than `suspended` clears the end.
- [ ] Re-suspending with a different end replaces it and records `user_suspended`, without revoking sessions again.
- [ ] Every `user_suspended` entry's snippet states the end, or that it has none.
- [ ] The suspended gate's 403 carries `suspendedUntil` and names the end in UTC; with no end, its text is unchanged.
- [ ] `authenticate` lifts an expired suspension to Normal before the gate, through a model call the sweep in 02 can reuse.
- [ ] Public profile and username lookups never hide an account whose end has passed.
- [ ] The admin user list, the status response, and the signed-in account record include `suspended_until`. Public reads do not.
- [ ] Supertest coverage per the spec's Testing Decisions. The past-end write test fails when the lazy lift is removed.
