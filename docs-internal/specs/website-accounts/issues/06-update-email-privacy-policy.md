# 06 — Update the email privacy disclosure

Status: needs-triage
Spec: [website accounts](../spec.md)

**What to finish:** The published policy accurately describes verification and password-reset mail before real mail is enabled.

**Dependencies:** Review of the revised policy wording. Release dependency for [04](04-deploy-mail-to-the-box.md).

**Decision — September 6, 2026:** Existing users must accept the revised policy. Bump `acceptance_version` when publishing it; the exact wording still needs review.

## Evidence

The [seed policy](../../../../src/assets/policies/privacy-policy.md) still says email is unused, never mailed, and never shared, and lists no Resend recipient. The [mail transport](../../../../src/utils/mail.js) sends the recipient and message to Resend when configured. The [policy schema step](../../../../src/schema/steps/privacyPolicy.js) seeds a fresh database and does not replace an existing live policy.

## Done when

- [ ] Agree the revised description of optional email, verification, recovery, and Resend's role.
- [x] Require renewed acceptance from existing accounts.
- [ ] Bump `acceptance_version` and verify that acceptance of the previous version does not satisfy the revised policy.
- [ ] Update the seed policy and its date.
- [ ] Publish the same approved text and version through the production admin Policies tab.
- [ ] Verify both fresh-database content and the live public policy response.
- [ ] Coordinate with [client ticket 08](../../../../../formamorph/docs-internal/specs/website-accounts/issues/08-site-register-privacy-acceptance.md) so site-created accounts have a usable acceptance path.

Reconciled September 6, 2026. This makes the follow-up named in tickets 01 and 02 explicit; no policy text or production row was changed during the inventory.
