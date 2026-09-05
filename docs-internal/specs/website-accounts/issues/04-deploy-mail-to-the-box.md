# 04 — Deploy mail to the box

Status: ready-for-human
Spec: ../spec.md

**What to build:** Production sends real mail. A verification mail from `noreply@formamorph.ai` lands in an inbox.

**Blocked by:** 01, 02, 03.

- [ ] Resend account, domain verified, DNS records added at Cloudflare.
- [ ] `RESEND_API_KEY` and `MAIL_FROM` in the server's production environment file.
- [ ] Server pulled, dependencies installed, boot schema applied, service restarted.
- [ ] One live verification mail received; one live reset completed.
