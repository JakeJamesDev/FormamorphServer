# Website accounts: remaining work

Audited September 6, 2026 against local source and ticket files. Server implementation baseline: `36bd871`.

## Implemented, awaiting human review

| Ticket | Evidence | Remaining |
|---|---|---|
| [01 — Register and verify](issues/01-register-with-email-and-verify.md) | `c14fa67`; email routes, capture transport, hashed tokens, boot schema | Human review; policy and production preflight tracked below |
| [02 — Set and resend email](issues/02-set-replace-resend-email.md) | `c245781`; authenticated routes and shared five-per-hour account budget | Limits approved; unchanged-address behavior and `mailSent` remain documented for review |
| [03 — Password reset](issues/03-password-reset-by-email.md) | `bca6cc3`; request and completion routes, one-hour tokens, session invalidation | Identifier budgets approved; timing validation remains |
| [05 — Profile by username](issues/05-public-profile-by-username.md) | `36bd871`; exact spelling then oldest visible folded match | Ownership approved; live integration remains |

Checked implementation boxes do not establish deployment. Explicitly approved decisions are recorded separately from remaining review work.

## Server alignment — September 6, 2026

- **Policy:** existing users must accept the revision. Ticket 06 still needs wording, the version bump, and publication.
- **Mail limits:** retain the implementation, including separate reset budgets for email and username.
- **Suspension:** ticket 07 is ready to implement public hiding through both lookups while preserving admin access.
- **Username ownership:** retain current behavior; ticket 08 is closed without a code change.
- **Still technical work:** reset timing validation, schema preflight, deployment, and real-mail verification. Client work below belongs to the separate project.

## Work needed for release

1. **Build the reset UI and Forgot password links.** [Client 07](../../../../formamorph/docs-internal/specs/website-accounts/issues/07-password-reset-pages.md) is still open. The [site router](../../../../formamorph/site/App.tsx) has no `/reset-password` page. Server 03 is implemented, so that coding dependency is satisfied; release and integration remain.
2. **Resolve policy acceptance on the site.** [Client 08](../../../../formamorph/docs-internal/specs/website-accounts/issues/08-site-register-privacy-acceptance.md) needs a choice of acceptance experience. The [register page](../../../../formamorph/site/pages/RegisterPage.tsx) registers and navigates without accepting the policy. Authenticated email settings use the policy-gated server middleware.
3. **Update and publish the mail disclosure.** [Server 06](issues/06-update-email-privacy-policy.md) tracks the seed text, required acceptance-version bump, and live policy row. Renewed acceptance is approved.
4. **Finish server review.** In particular, ticket 03's tests establish matching responses and independence from delivery latency, not a complete timing non-enumeration guarantee. Its remaining validation is now explicit.
5. **Configure and deploy real mail.** [Server 04](issues/04-deploy-mail-to-the-box.md) now includes Resend/DNS, environment values and site URL, duplicate-email preflight, database backup and schema verification, policy publication, and live verification/reset/session-invalidation checks. Production state is unverified.

## Follow-up disposition

- [Server 07 — Profile suspension consistency](issues/07-profile-suspension-consistency.md): approved and ready to implement. Hide publicly through both routes, preserving admin moderation access.
- [Server 08 — Username case ownership](issues/08-username-case-ownership.md): closed; retain exact spelling/oldest-visible selection and case-sensitive registration.
- The client spec asks for light and dark themes, while [client 01](../../../../formamorph/docs-internal/specs/website-accounts/issues/01-site-entry-login-register.md) explicitly defers light mode until the landing page supports it. This remains a product deferral, not completed scope.

## Cross-repository ticket drift

Client tickets 01–06 are marked `ready-for-human`; 07 is `ready-for-agent`; 08 is `needs-triage`. Client tests and deployment were not rerun in this audit.

The [client profile ticket](../../../../formamorph/docs-internal/specs/website-accounts/issues/04-public-profile.md) still says the server endpoint does not exist. Server 05 now implements it; only deployment and live integration remain unverified. Client 01's historical note about five unimplemented routes is also stale: the local router now includes account, own-profile, public-profile, and verification pages. These client files were inspected but not edited as part of this server ticket reconciliation.

## Verification

The focused server run passed **124 tests across six files**, in **10.37 seconds wall time** (Vitest: 8.05 seconds; aggregate test time: 9.49 seconds across parallel workers). No prolonged process-exit gap was observed.

Files: [account email](../../../tests/accountEmail.test.js), [password reset](../../../tests/passwordReset.test.js), [boot schema](../../../tests/bootSchema.test.js), [profile by username](../../../tests/userProfileByUsername.test.js), [UUID profile](../../../tests/userProfile.test.js), and [token invalidation](../../../tests/tokenInvalidation.test.js).

The initial `npm` invocation could not start because `npm` was absent from PATH (1.58 seconds); the successful run invoked the installed Vitest entry with `node.exe`. This was a focused regression check, not a full security audit or a production mail test.
