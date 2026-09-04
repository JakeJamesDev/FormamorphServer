# Production server

How api.formamorph.ai is hosted, backed up, and changed. Verified against the live host on 2026-09-04.

## At a glance

| Item | Value |
|---|---|
| Provider | Hetzner CX22, hostname `formamorph-api` |
| OS | Ubuntu 26.04 LTS, Node 24, rclone 1.75 |
| Service | systemd unit `formamorph-api`, runs as user `formamorph` |
| Checkout | `/srv/formamorph/app` (git clone of `main`) |
| Env file | `/srv/formamorph/app/.env` (local copy: `.env.production`, gitignored) |
| Proxy | Caddy, direct TLS via Let's Encrypt, proxies to `127.0.0.1:8797` |
| Firewall | ufw: 22, 80, 443 only |
| SSH | key only, root login off. Local alias `formamorph-api` |
| Database | `/srv/formamorph/data/exotic-dangerous.db` |
| Uploads | `/srv/formamorph/storage/{avatars,event-posters,thumbnails,worlds}` |
| Offsite | Cloudflare R2 buckets `formamorph-files` and `formamorph-backups` |

Data and uploads live **outside** the checkout, so a fresh clone or `git clean` cannot touch them.
The paths come from `DATA_DIR`, `DB_PATH`, and `STORAGE_ROOT` in the env file (see `src/config/paths.js`).

## Connecting

From Git Bash, pass the key explicitly. `~` resolves to the wrong home there.

```bash
ssh formamorph-api -i /c/Users/<you>/.ssh/id_ed25519_formamorph -o IdentitiesOnly=yes
```

The `formamorph` user has passwordless sudo.

## Service

Unit file: `/etc/systemd/system/formamorph-api.service`. It sets `Restart=always`, `RestartSec=5`,
`ProtectSystem=full`, and `ReadWritePaths=/srv/formamorph`. The app self-migrates the schema on boot.

```bash
sudo systemctl status formamorph-api        # state
journalctl -u formamorph-api -n 50 -f       # logs
sudo systemctl restart formamorph-api       # restart
```

⚠️ Check `is-active` at least 6 s after a restart. At 2 s it still reports `activating`.
A unit stuck in `activating` with repeated restarts almost always means a missing env key.

## Deploying code

1. Commit and push to `main` from GitHub Desktop.
2. Run on the server:

```bash
cd /srv/formamorph/app && git pull && npm ci --omit=dev && sudo systemctl restart formamorph-api
```

3. Wait 6 s, then check `systemctl is-active formamorph-api` and the journal.

`npm ci` takes about 4 minutes because `better-sqlite3` compiles from source. Rollback is `git checkout <old sha>`
and the same `npm ci` + restart. Migrations are additive, so old code runs on a newer schema.

## Changing configuration

| Change | Where | Then |
|---|---|---|
| New env key | `/srv/formamorph/app/.env` (edit by hand, keep `.env.production` in sync) | `sudo systemctl restart formamorph-api` |
| Proxy, body cap, domain | `/etc/caddy/Caddyfile` | `sudo systemctl reload caddy` |
| Unit settings | `/etc/systemd/system/formamorph-api.service` | `sudo systemctl daemon-reload && sudo systemctl restart formamorph-api` |
| Backup schedule or steps | `crontab -e` as `formamorph`, script at `/usr/local/bin/formamorph-backup` | nothing, cron reads it live |
| R2 credentials for rclone | `~/.config/rclone/rclone.conf` (remote `r2:`) | test with `rclone lsd r2:` |

Env keys present on the server (values omitted): `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_BACKUP_BUCKET`, `R2_ENDPOINT`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_URL`, `API_HOSTNAME`, `SSH_KEY_NAME`, `SERVER_IP`, `SSH_USER`,
`PORT`, `NODE_ENV`, `JWT_SECRET`, `JWT_EXPIRE`, `DATA_DIR`, `DB_PATH`, `STORAGE_ROOT`, `SIGNAL_SALT`.

## Backups

A cron job for the `formamorph` user runs `/usr/local/bin/formamorph-backup` daily at **04:17 UTC**.
Output goes to `/var/log/formamorph-backup.log`.

The script does, in order:

1. `npm run backup` — full local backup (DB, worlds, thumbnails, avatars) into `backups/backup-<timestamp>/`.
   Format and restore details: [BACKUP_RESTORE_DOCUMENTATION.md](../BACKUP_RESTORE_DOCUMENTATION.md).
2. `npm run cleanup-backups -- 1` — keeps only the newest local backup. Peak use is two backups (~13 GB) during the run.
3. Compresses the DB copy with `zstd -9` (about 25% smaller; `preview_data` is mostly base64 and does not compress well).
4. `rclone -v copyto` the `.zst` to `r2:formamorph-backups/db-history/<YYYY-MM-DD>.db.zst`.
5. Prunes that folder with `--min-age 14d` — 14 daily DB snapshots retained, long enough to revert after a two-week absence.
6. Refuses to continue if `/srv/formamorph/storage` is empty (guard against syncing an empty tree).
7. `rclone -v sync /srv/formamorph/storage r2:formamorph-files` — mirror of all uploads. Removals propagate.

So there are three layers: local full backup (yesterday only), offsite DB history (14 days), offsite file mirror (current only).

### Checking backups

```bash
tail -40 /var/log/formamorph-backup.log
ls -1 /srv/formamorph/app/backups
rclone lsl r2:formamorph-backups/db-history
rclone size r2:formamorph-files
```

### Restoring

- **Whole server, recent**: stop the unit, `npm run restore <backup-name>` (it snapshots current data first), start the unit.
- **Database from a specific day**: stop the unit, `rclone copyto r2:formamorph-backups/db-history/<date>.db.zst /tmp/db.zst`,
  `zstd -d /tmp/db.zst -o /srv/formamorph/data/exotic-dangerous.db -f`, start the unit.
- **Lost upload files**: `rclone sync r2:formamorph-files /srv/formamorph/storage`. Note the direction.
- **Lost host**: new box, install Node 24 + Caddy + rclone, recreate the unit and Caddyfile above, restore the env
  file from `.env.production`, restore the rclone config, then run the two rclone restores.

## Cost

| Item | Per month |
|---|---|
| Hetzner CX22 (Helsinki, IPv4 and 20 TB traffic included) | €3.79 before VAT |
| Cloudflare R2 | $0 under 10 GB, then $0.015/GB. Expected use ~12 GB, so about $0.03 |
| Cloudflare DNS | $0 |
| Domain formamorph.ai | about $70 to $100 per year |

## Known gaps

- No fail2ban. SSH is key-only, so this is low priority.
- R2 sits just over the free tier because the `worlds.preview_data` column holds ~500 MB of base64 text.
  Moving previews to files (like thumbnails) would shrink every DB copy by 80% and bring R2 to $0.
- No alerting. Nothing notifies anyone if the unit or the cron job fails.
- The pre-edit backup script is kept at `/usr/local/bin/formamorph-backup.bak`.
