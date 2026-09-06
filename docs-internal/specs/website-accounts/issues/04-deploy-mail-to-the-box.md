# 04 — Deploy mail to the box

Status: ready-for-human
Spec: [website accounts](../spec.md)

**What to build:** Production sends real mail. A verification mail from `noreply@formamorph.ai` lands in an inbox.

**Dependencies:** Server 01–03 are implemented, pending review. Public release also needs [06](06-update-email-privacy-policy.md), the client's verification page (implemented), [client reset ticket 07](../../../../../formamorph/docs-internal/specs/website-accounts/issues/07-password-reset-pages.md), and resolution of [client privacy acceptance ticket 08](../../../../../formamorph/docs-internal/specs/website-accounts/issues/08-site-register-privacy-acceptance.md).

- [ ] Resend account, domain verified, DNS records added at Cloudflare.
- [ ] `RESEND_API_KEY` and `MAIL_FROM` in the server's production environment file.
- [ ] Confirm `SITE_URL` points to the released site (default `https://formamorph.ai`) and both mail landing pages work.
- [ ] Check the production database for duplicate non-null emails, including repeated empty strings, before applying the case-insensitive unique index. Resolve any collision before release; do not assume the historical empty-column claim remains true.
- [ ] Back up the database before applying the schema.
- [ ] Server pulled, dependencies installed, boot schema applied, service restarted.
- [ ] Confirm `email_verified_at`, `account_tokens`, and the unique email index actually exist after restart; the migration error is non-fatal at boot.
- [ ] Updated policy published to the live database and the acceptance-version decision applied ([06](06-update-email-privacy-policy.md)).
- [ ] One live verification mail received; one live reset completed.
- [ ] Confirm the reset invalidates a session opened before it, and the used link cannot be replayed.
- [ ] Verify the site public profile against the deployed by-username endpoint; the client ticket's mock check does not establish live integration.

## Verification status

Reconciled September 6, 2026. No production environment, DNS, database, deployment, or inbox was inspected in this audit. These boxes remain open pending direct evidence.

Production preflight query:

```sql
SELECT email, COUNT(*)
FROM users
WHERE email IS NOT NULL
GROUP BY email COLLATE NOCASE
HAVING COUNT(*) > 1;
```
