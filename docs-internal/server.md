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
and the same `npm ci` + restart.

⚠️ Migrations were additive until the `preview_data` drop (2026-09-04), so old code ran on a newer schema.
That no longer holds. Code from before that deploy names the dropped column and fails on every publish.
**Rolling back past it means restoring the database too** — see [One-time reclaim](#one-time-reclaim-2026-09-04).

### One-time reclaim (2026-09-04)

The `dropPreviewData` schema step removes `worlds.preview_data` on boot. SQLite does not return the freed
pages to the file, so the disk only shrinks after a `VACUUM`. A vacuum rewrites the whole file and cannot
run inside a transaction, so it is **not** part of the boot step. Run it once, with the service stopped:

```bash
sudo systemctl stop formamorph-api
ls -l /srv/formamorph/data/exotic-dangerous.db
sqlite3 /srv/formamorph/data/exotic-dangerous.db 'VACUUM;'
ls -l /srv/formamorph/data/exotic-dangerous.db
sudo systemctl start formamorph-api
```

If `sqlite3` is not installed, the app's own driver does the same job:

```bash
cd /srv/formamorph/app && node -e "new (require('better-sqlite3'))('/srv/formamorph/data/exotic-dangerous.db').exec('VACUUM')"
```

Expect about **574 MB before and a few MB after**: the column held ~500 MB of base64 text across 661
listings, against ~2 MB for everything else, and a `zstd -9` snapshot went from ~430 MB to a fraction of a
few MB. That was ~6 GB of the ~12 GB in R2, which is what put the bucket over its free tier.

The vacuum needs free disk equal to the current file, because it writes a full copy before swapping it in.
The two `ls -l` lines above give the real figures. Record them here in place of the estimate once it has run.

The restore point for this deploy is the nightly R2 snapshot from the morning it ran,
`r2:formamorph-backups/db-history/2026-09-04.db.zst`. It is the last copy that still has the column.

## Changing configuration

| Change | Where | Then |
|---|---|---|
| New env key | `/srv/formamorph/app/.env` (edit by hand, keep `.env.production` in sync) | `sudo systemctl restart formamorph-api` |
| Proxy, body cap, domain | `/etc/caddy/Caddyfile` | `sudo systemctl reload caddy` |
| Unit settings | `/etc/systemd/system/formamorph-api.service` | `sudo systemctl daemon-reload && sudo systemctl restart formamorph-api` |
| Backup schedule or steps | `crontab -e` as `formamorph`, script at `/usr/local/bin/formamorph-backup` | nothing, cron reads it live |
| R2 credentials for rclone | `~/.config/rclone/rclone.conf` (remote `r2:`) | test with `rclone lsd r2:` |
| Minimum client version per route | `PUT /api/settings/client_minimums` as staff | nothing, the next request reads it |

### Requiring a newer client on one route

Raising a minimum needs no deploy and no restart. Send the whole map, because a write replaces it:

```bash
curl -X PUT https://api.formamorph.ai/api/settings/client_minimums \
  -H "Authorization: Bearer $STAFF_TOKEN" -H 'Content-Type: application/json' \
  -d '{"value":{"POST /api/reports":{"minVersion":"2.17.0","feature":"Reporting"}}}'
```

A key is a method, a space, and a path, and it covers everything under that path. Below the minimum the
server answers `426` with `{ code: "CLIENT_UPDATE_REQUIRED", minVersion, feature }`, which every client
turns into one update dialog naming the feature. `{"value":{}}` gates nothing, which is the default.

⚠️ Gate a route the staff screens themselves need and staff on an older build lose it too. `/api/settings`
is exempt in code, so the lever that raised a minimum can always be reached to lower it again.

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
3. Compresses the DB copy with `zstd -9`. A snapshot is a fraction of a few MB since the `preview_data` drop.
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
| Cloudflare R2 | $0 under 10 GB, then $0.015/GB. Back under the free tier since the `preview_data` drop |
| Cloudflare DNS | $0 |
| Domain formamorph.ai | about $70 to $100 per year |

## Deploy log

- **2026-09-06** — deployed `bb348e1`: email-account schema, password-reset endpoints, username profile
  lookup, and suspended-profile hiding. Removed the unused example administrator and promoted the owner's
  account; the duplicate-email preflight then passed. SQLite backups before deployment, account changes,
  and policy publication are in the server's `backups/` directory. Published the committed privacy text
  at acceptance version 2, requiring renewed acceptance. All 1,371 tests passed in 15.06 s wall time;
  production schema, database integrity, public responses, and service stability passed verification.
  Real mail remains unconfigured. Dependency installation reported 15 vulnerabilities (1 low, 5 moderate,
  9 high); dependency remediation was outside this deployment.
- **2026-09-04** — dropped `worlds.preview_data` (commit `cd2cbcb`). Pre-deploy backup `pre-drop-preview-data` in
  `backups/`; it is the only restore point that works with older code. Boot step took under a second; a manual
  `VACUUM` with the service stopped shrank the database from 602 MB to 3.3 MB.

## Known gaps

- No fail2ban. SSH is key-only, so this is low priority.
- No alerting. Nothing notifies anyone if the unit or the cron job fails.
- The pre-edit backup script is kept at `/usr/local/bin/formamorph-backup.bak`.
