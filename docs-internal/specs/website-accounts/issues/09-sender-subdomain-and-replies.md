# 09 — Send from a subdomain and route replies

Status: ready-for-human
Spec: [website accounts](../spec.md)

**What to build:** Mail comes from `Formamorph <account@mail.formamorph.ai>`. A reply goes to `support@formamorph.ai` and lands in the maintainer's inbox.

The code is done: `MAIL_REPLY_TO` sets the Reply-To header, and the header is left off when it is unset. The rest is DNS and the production environment.

Today `formamorph.ai` has a null MX and `v=spf1 -all`, so mail to `support@formamorph.ai` bounces. Set up routing before `MAIL_REPLY_TO` goes live.

## Steps

- [x] **Resend:** add the domain `mail.formamorph.ai`. Add its DNS records at Cloudflare as DNS only (gray cloud). Wait for Verified.
- [x] **Cloudflare Email Routing** on `formamorph.ai`: delete the null MX record, enable routing, and accept its MX and SPF records. Add `support@formamorph.ai` → your inbox, and verify the destination.
- [x] **Check routing:** send a mail to `support@formamorph.ai` from another account. It arrives.
- [x] **Production environment:** set `MAIL_FROM="Formamorph <account@mail.formamorph.ai>"` and `MAIL_REPLY_TO=support@formamorph.ai`. Restart the service.
- [ ] **Check live mail:** request a verification mail. Its headers show the new From, the Reply-To, and DKIM and DMARC passing for `mail.formamorph.ai`. A reply arrives at the support inbox.
- [ ] **After a week of clean sends:** remove `formamorph.ai` from Resend, then delete its `resend._domainkey` and `send` records.

## Verification status

September 30, 2026: public DNS shows the `mail.formamorph.ai` DKIM key and the Cloudflare MX records on `formamorph.ai`. The box runs a build with `21b0063`, restarted after the env change. Resend logged a verification mail from `account@mail.formamorph.ai` with Reply-To `support@formamorph.ai`. The inbox header check and the reply test are not recorded.
