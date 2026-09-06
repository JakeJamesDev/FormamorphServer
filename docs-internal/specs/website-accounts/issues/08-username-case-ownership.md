# 08 — Decide username case and shared-link ownership

Status: closed-no-change
Spec: [website accounts](../spec.md)

**Decision — September 6, 2026:** Retain the current ownership rules: case-sensitive registration, exact-spelling profile ownership, and oldest visible match for other spellings. No username migration or changes to login/reset lookup are requested.

## Evidence

The [users schema](../../../../src/schema/tables.js) permits case-distinct usernames. [Ticket 05](05-public-profile-by-username.md) preserves exact-spelling ownership and otherwise returns the oldest visible match. Its index supports lookup, not case-insensitive uniqueness.

## Done when

- [x] Accept the existing shared-link ownership rule.
- [x] Record an explicit decision to retain current behavior; collision handling and a uniqueness migration are unnecessary for this decision.

Reconciled September 6, 2026. No production names were inspected or changed.
