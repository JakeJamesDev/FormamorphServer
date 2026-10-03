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

No restore point for this deploy remains. The last copy that still had the column was the nightly R2
snapshot from the morning it ran, and the 14-day prune deleted it on 2026-09-18.

## Changing configuration

| Change | Where | Then |
|---|---|---|
| New env key | `/srv/formamorph/app/.env` (edit by hand, keep `.env.production` in sync) | `sudo systemctl restart formamorph-api` |
| Proxy, body cap, domain | `/etc/caddy/Caddyfile` | `sudo systemctl reload caddy` |
| Unit settings | `/etc/systemd/system/formamorph-api.service` | `sudo systemctl daemon-reload && sudo systemctl restart formamorph-api` |
| Backup schedule or steps | `crontab -e` as `formamorph`, script at `/usr/local/bin/formamorph-backup` | nothing, cron reads it live |
| R2 credentials for rclone | `~/.config/rclone/rclone.conf` (remote `r2:`) | test with `rclone lsd r2:` |
| Minimum client version per route | `PUT /api/settings/client_minimums` as staff | nothing, the next request reads it |
| Bundled world and Avatar list | `src/config/bundledFingerprints.json`, copied from the client repo by its release step | commit and deploy; the server reads it once at start |

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
Output goes to `/var/log/formamorph-backup.log`. The script before the 2026-09-09 rewrite is kept at
`/usr/local/bin/formamorph-backup.prev`.

The script does, in order:

1. Copies the database with the driver's online backup API into `backups/db-<YYYY-MM-DD>.db` and runs
   `integrity_check` on the copy. A bad check stops the run.
2. Compresses it with `zstd -9` and removes the raw copy. A snapshot is about 1 MB.
3. `rclone copyto` the `.zst` to `r2:formamorph-backups/db-history/<YYYY-MM-DD>.db.zst`, then prunes that
   folder with `--min-age 14d`. Local `.zst` snapshots older than 14 days are pruned the same way.
4. Refuses to continue if `/srv/formamorph/storage` is empty (guard against syncing an empty tree).
5. `rclone sync /srv/formamorph/storage r2:formamorph-files` with
   `--backup-dir r2:formamorph-backups/files-deleted/<YYYY-MM-DD>`. A file removed or overwritten on the
   server moves into that day's folder instead of vanishing from R2.
6. Purges `files-deleted/<date>` folders older than 14 days **by folder name**. Moved files keep their
   original modification time, so `--min-age` would prune them on arrival.

So there are three layers: DB history (local and offsite, 14 days), offsite file mirror (current), and
offsite history of removed files (14 days). There is no local copy of uploads since 2026-09-09: it doubled
disk use, peaked at three copies during the run, and only reached one day back. `npm run backup` still
exists for a manual full copy; `npm run restore` only applies to a directory it made.

### Checking backups

```bash
tail -40 /var/log/formamorph-backup.log
ls -1 /srv/formamorph/app/backups
rclone lsl r2:formamorph-backups/db-history
rclone lsf r2:formamorph-backups/files-deleted --dirs-only
rclone size r2:formamorph-files
```

### Restoring

- **Whole server, recent**: the database from `db-history` (next bullet) plus the upload mirror (the **Lost upload files** bullet).
- **A file removed or overwritten in the last 14 days**: find it under `r2:formamorph-backups/files-deleted/<date>/`,
  then `rclone copyto` it back to the same path under `/srv/formamorph/storage`. The next nightly sync re-mirrors it.
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

- **2026-10-03** — deployed `c4575d3`: Patreon account links, webhooks, hourly reconcile, supporter flair on
  author payloads, the supporters wall, and feedback list filters, search, and sorts. All 2,056 tests passed in
  32.1 s wall time. Backup `backups/pre-deploy-fd8928a-2026-10-03T18-59-37.525Z.db`, integrity `ok`. Boot
  applied `tables`, which added `patreon_links` and `patreon_pending_links`; the step is additive, so a rollback
  needs no restore. The server `.env` has no `PATREON_*` key yet. Each key defaults to empty, so Patreon stays
  off and the webhook answers 503. `npm ci` showed the same skipped `better-sqlite3` install-script warning.
  Service active with zero restarts, public route 200.
- **2026-09-30** — deployed `fd8928a`: a stored Changelog Entry count on catalog rows. All 1,825 tests
  passed in 22.1 s wall time. Schema step `changelogCount` added `worlds.changelog_count` and backfilled it;
  the journal shows `Schema: applied changelogCount`. Backup
  `backups/pre-deploy-21b0063-2026-09-30T21-33-53.137Z.db`, integrity `ok`. The step is additive, so a
  rollback needs no restore. `npm ci` showed the same skipped `better-sqlite3` install-script warning.
  Service active with zero restarts, public route 200.
- **2026-09-30** — deployed `21b0063`: hidden like counts on contest listings, profiles, and like replies,
  rate limits keyed on the proxied address, new bundled world fingerprints, and mail from the `mail.`
  subdomain with a Reply-To. All 1,813 tests passed in 31.6 s wall time. No schema or policy change, so no
  backup. `MAIL_FROM` and `MAIL_REPLY_TO` have defaults and the server `.env` already sets both. `npm ci`
  showed the same skipped `better-sqlite3` install-script warning. Service active with zero restarts, public
  route 200.
- **2026-09-30** — deployed `f7b4e60`: listing details skip the inlined thumbnail. All 1,738 tests passed in
  21.3 s wall time. No schema, policy, or env change, so no backup. `npm ci` warned that npm 11 skipped the
  `better-sqlite3` install script; the package loads its bundled `linux-x64` prebuild, so no rebuild is needed.
  Service active with zero restarts, public route 200.
- **2026-09-29** — deployed `b05d8e1`: the stand-in thumbnail flag for listings and Avatars, refusal of
  bundled worlds and the default Avatar on publish and update, admin-only user emails, and account mail with a
  button. All 1,737 tests passed in 30.6 s wall time. Pre-deploy backup
  `pre-deploy-038c50f-2026-09-29T18-40-05.600Z.db` in `backups/`, integrity `ok`. Boot applied
  `placeholderFlag`, an additive column, so a rollback needs no restore. `npm run backfill-placeholders` did not
  run. The journal shows no missing mail key. Service active with zero restarts, public route 200.
- **2026-09-20** — deployed `038c50f`: `npm run publish-policy`, which puts the authored Privacy Policy into
  the live row. All 1,691 tests passed in 22.1 s wall time. Pre-deploy backup
  `pre-deploy-247fb75-2026-09-20T13-11-54.152Z.db` in `backups/`, integrity `ok`. No schema step ran. Published
  the 20 September text with re-accept, acceptance version 2 to 3. The dry run showed no Policies tab edit.
  The public policy route serves the new date line. Service active with zero restarts, public route 200.
- **2026-09-20** — deployed `247fb75`: anonymous likes with a per-connection cap and claim on sign-in, contest
  ties on the podium, and prompt listings stamped with their models and app version. All 1,678 tests passed in
  30.9 s wall time. Pre-deploy backup `pre-deploy-759334f-2026-09-20T12-55-27.022Z.db` in `backups/`, integrity
  `ok`. Boot applied `tables`, `promptModels`, `promptAppVersion`, `placementTies`, `likeClaims`, and `indexes`.
  `placementTies` rebuilds `event_placements`, so a rollback past it restores the backup first. The table held
  0 rows before and after. The privacy policy seed file changed, but the live row did not until `038c50f`.
  Service active with zero restarts, public route 200.
- **2026-09-17** — deployed `759334f`: an add-on offer dated by when it was made, and the likes audit no
  longer logged. All 1,484 tests passed in 15.9 s wall time. No schema change, so no pre-deploy backup.
  Service active with zero restarts, public route 200.
- **2026-09-10** — deployed `998eb88`: listing relationships with unlisted visibility, and the world content
  limit lowered to 100 MB. All 1,484 tests passed in 15.8 s wall time. Pre-deploy backup
  `pre-deploy-2fd6196-2026-09-11T00-21-09.554Z.db` in `backups/`, integrity `ok`. Boot applied `tables`,
  `linkedContent`, and `indexes`, all additive. Service active with zero restarts, public route 200. Caddy's
  body cap stays at 210 MB, above the new limit, so no proxy change.
- **2026-09-09** — deployed `2fd6196`: the model listing kind gated on the VRM's embedded license, an Avatar
  listing's own license terms, and quarantined listings kept in the author's own list. All 1,437 tests passed in
  15.5 s wall time. Pre-deploy backup `pre-deploy-73e3112-2026-09-09T16-44-58.498Z.db` in `backups/`, integrity
  `ok`. Boot applied the additive `modelLicense` step. Service active with zero restarts, public route 200.
- **2026-09-09** — rewrote the nightly backup script (no code deploy). The upload mirror now keeps removed and
  overwritten files 14 days under `files-deleted/<date>`, the local full copy of uploads is gone, and the
  database snapshot is a driver backup with an integrity check. The first manual run passed in 54 s and moved
  one overwritten world file and one deleted thumbnail into the new folder. Disk was 17 GB of 38 GB with the
  last `backup-*` directory (5.8 GB) still present; it is removed by hand, nothing prunes it now.
- **2026-09-07** — deployed `73e3112` to persist content-warning acceptance per account. All 1,377 tests
  passed in 22.80 s wall time. The pre-deploy SQLite backup passed its integrity check; startup applied
  `ageGate` at version 1 and preserved privacy version 2. Verified database integrity, no foreign-key
  errors, catalog availability, and authentication on both new routes. Service active with zero restarts.
- **2026-09-06** — deployed `bb348e1`: email-account schema, password-reset endpoints, username profile
  lookup, and suspended-profile hiding. Removed the unused example administrator and promoted the owner's
  account; the duplicate-email preflight then passed. SQLite backups before deployment, account changes,
  and policy publication are in the server's `backups/` directory. Published the committed privacy text
  at acceptance version 2, requiring renewed acceptance. All 1,371 tests passed in 15.06 s wall time;
  production schema, database integrity, public responses, and service stability passed verification.
  Real mail remains unconfigured. Dependency installation reported 15 vulnerabilities (1 low, 5 moderate,
  9 high); dependency remediation was outside this deployment.
- **2026-09-04** — dropped `worlds.preview_data` (commit `cd2cbcb`). Pre-deploy backup `pre-drop-preview-data` in
  `backups/` was the only restore point that worked with older code; the old nightly cleanup has since removed
  it. Boot step took under a second; a manual
  `VACUUM` with the service stopped shrank the database from 602 MB to 3.3 MB.

## Known gaps

- No fail2ban. SSH is key-only, so this is low priority.
- No alerting. Nothing notifies anyone if the unit or the cron job fails.
- Older backup scripts are kept at `/usr/local/bin/formamorph-backup.bak` and `.prev` (before 2026-09-09).
