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
| Active installs on or off | `PUT /api/settings/active_installs` as staff, `{"value":true}`. Off by default; turn it on only after the privacy policy that names the Daily Send is live | nothing, the next send reads it |
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

⚠️ `CLOUDFLARE_ANALYTICS_TOKEN` is new: a Cloudflare API token with only **Account Analytics: Read**. The storage
check uses it with `R2_ACCOUNT_ID`, `R2_BUCKET` and `R2_BACKUP_BUCKET` to read the bucket sizes. Add it to the
server env file by hand before the R2 storage ticket deploys. Without it the check skips R2 and the storage
report's `r2` is null.

## Formamorph AI pledge freshness

- A pledge counts only while its `checked_at` is at most 7 days old (`PLEDGE_CONFIRMED_MS`).
- A held tier with a null `checked_at` counts as unconfirmed.
- The proxy refuses it with `pledge_unconfirmed`, and the Hosted state reads `unconfirmed`.
- A live grant still serves. Flair and the Supporters wall do not change.
- The next successful Patreon read restores service with no action.

Webhook deliveries are signals, because Patreon sends no delivery id:

- A delete trigger clears the tier at once, and it stays cleared if the read fails.
- Every tier trigger asks for a read of the member list (`READ_DEBOUNCE_MS` after the first delivery of a burst). The list decides.
- A non-ending delivery changes no tier and no `checked_at` by itself, so a replay cannot extend the cutoff.
- A delivery during any read voids that read's list, because it may be older than the delivery, and gets one more read.
- A burst longer than the wait can make more than one read. The first delivery starts the wait, so a stream cannot defer the read.
- A failed delivery read logs and does not count toward the alert. The next hourly run repairs it.
- ⚠️ Unverified: the member list may lag behind a webhook. A new tier could then wait for a later read.

## Testing Formamorph AI with the testing key

`npm run live:hosted-ai` sends real calls through the real app on this machine. Only the upstream call
leaves it. Nothing touches production, so tests don't count toward the daily ceiling or the usage report.

| Part | In the run |
|---|---|
| App, route, limits, retries, metering | Real |
| Upstream URL | Real |
| `hosted_ai` setting | Copied from production |
| API key | `HOSTED_AI_TEST_API_KEY`, spent on the testing account |
| Database, storage, account | Scratch, gone after the run |
| Caddy | Not covered. See [Check Caddy](#2-check-caddy) |

**One-time setup.** Add these to the local `.env`. The values live in the local hosted-tier note.

```
HOSTED_AI_UPSTREAM_URL=<upstream URL>
HOSTED_AI_TEST_API_KEY=<testing key>
```

**Refresh the settings copy** whenever production's `hosted_ai` setting changes. The copy holds prices, so
it stays in the unshared `.scratch/` folder. Run this in PowerShell from the repo root.

```powershell
ssh formamorph-api -i "$HOME\.ssh\id_ed25519_formamorph" -o IdentitiesOnly=yes 'cd /srv/formamorph/app && node -e ''require(`dotenv`).config(); console.log(JSON.stringify(require(`./src/models/Setting`).get(`hosted_ai`)))''' | Set-Content -Encoding ascii .scratch\hosted-ai-settings.json
```

**Run it.**

```bash
npm run live:hosted-ai -- --prompt "Describe a tavern." --max-tokens 400
```

- `--mode` picks `stream`, `whole` or `both`. `--tier` picks the account's tier.
- `--body` sends a full chat completion from a JSON file, such as a captured client request.
- It prints each reply and usage row. `PASS` needs every call to settle `ok`, with no open row or held slot.

## Formamorph AI launch checklist

Work top to bottom. Each step needs the one before it.

### 1. Prove the proxy under load

Run the load script on the production host in a quiet window. It uses a scratch in-memory database and a fake
upstream, so it never reads the real database or the upstream key.

```bash
cd /srv/formamorph/app && npm run load:hosted-ai -- --accounts 20 --parallel 4 --turns 5 --delay-ms 800
```

- It prints p50 and p90 time to first byte, failures by code, rows left `open` and parallel slots held.
- `PASS` needs zero open rows, zero held slots and no failure the flags did not plan.
- Pass `--expect rate_limited` (or another refusal code) only when the run is meant to trigger it, for
  example with a low `--parallel-limit`.
- Latency is information, not a gate. Compare it with the planned limits and decide.

### 2. Check Caddy

- The route body limit is `HOSTED_BODY_LIMIT` in `src/config/hostedAi.js`. The Caddyfile `request_body`
  cap in `/etc/caddy/Caddyfile` must be at or above it. It was 210 MB at last check.
- Streaming check, by hand, on the real host: send a streamed request through `https://api.formamorph.ai`
  and confirm the chunks arrive one by one, not all at the end. The load script cannot see Caddy.

### 3. Set the environment

Add these keys to `/srv/formamorph/app/.env` by hand and keep `.env.production` in sync. Names only here.
The values live in the local hosted-tier note.

| Key | Purpose |
|---|---|
| `HOSTED_AI_UPSTREAM_URL` | Upstream chat-completions URL, ending in `/chat/completions` |
| `HOSTED_AI_API_KEY` | Upstream key. Never in settings, responses or logs |
| `HOSTED_AI_USER_SECRET` | Signs the anonymous `user` id. Generate once, never rotate |
| `HOSTED_AI_BALANCE_URL` | Provider balance read. Unset skips the read |
| `HOSTED_AI_USAGE_URL` | Provider per-day usage read. Unset skips the read |
| `STAFF_ALERT_EMAIL` | Where pause, low-balance and Patreon reconcile alerts are mailed |
| `AWS_ACCESS_KEY_ID` | Access key of the IAM user that sends mail through Amazon SES. Unset turns mail off |
| `AWS_SECRET_ACCESS_KEY` | Its secret. Never in settings, responses or logs |
| `AWS_REGION` | SES region. Defaults to `us-east-2` |
| `SES_CONFIGURATION_SET` | SES configuration set every mail is sent with. Unset turns mail off |
| `SES_EVENTS_SECRET` | Shared secret EventBridge sends to the mail-event webhook. Unset answers 503 to every event (see Mail events) |
| `PATREON_SUPPORTER_TOP_TIER_ID` | Patreon tier ID for the top tier |

Then write the `hosted_ai` setting as admin (`PUT /api/settings/hosted_ai`). Until every value is set, the
proxy answers `service_paused`.

A day that reaches `dailyCeiling` also answers `service_paused`, until 00:00 UTC or an admin lift. Every call
stops at once, started turns included. A call already streaming finishes.

### 4. Run one process

The API must run as one process. Admission and reservation share one synchronous transaction, and the
per-account parallel and per-minute limits live in process memory. A second process (cluster mode, PM2
instances, a second unit) splits those counters and lets parallel calls pass the same budget sum.

### 5. Set the turn limit above the idle limit

`turnLimitSeconds` must exceed the longest call the idle limit allows. The hourly sweep settles any row still
`open` after the turn limit as `estimated`. A turn limit below a live call's length lets the sweep settle
that call while it still runs.

### 6. Roll out in this order

1. **Deploy** the code and restart (see Deploying code). Check the journal. The privacy policy must
   already name "a third-party AI provider" as a recipient of Formamorph AI turns, with no provider name.
2. **Closed beta on staff grants.** Staff create grants for testers (`/api/hosted-ai/admin/…`), each with
   an end date. Watch spend per subject and the spend-versus-estimate report.
3. **Open to Supporters.** Staff decide when the beta ends. The proxy route's entry in `client_minimums`
   (see Requiring a newer client on one route) names the first client build that ships Formamorph AI.

## Mail events

SES reports what happened to each mail: delivered, delayed, bounced or complained. EventBridge forwards
those events to `POST https://api.formamorph.ai/api/mail/events`. Each event moves its row in `mail_log`.

📬 **Setup, once, in `us-east-2`:**

1. Generate a long random secret. Put it in `/srv/formamorph/app/.env` and `.env.production` as
   `SES_EVENTS_SECRET`, then restart.
2. On the SES configuration set, add an **EventBridge** event destination for **Delivery**, **Delivery
   delay**, **Bounce** and **Complaint**. Never turn on Open or Click.
3. In EventBridge, create a **connection** with **API key** authorization:
   - Key name: `X-SES-Events-Secret`
   - Value: the secret from step 1
4. Create an **API destination**: `POST` to the webhook URL above, with that connection.
5. Create a **rule** on the default event bus with the pattern `{"source": ["aws.ses"]}`. Target the API
   destination and send the whole event, with no input transformer.
6. Prove it: send one mail to `bounce@simulator.amazonses.com` and check that its row moves to `bounced`.

- The webhook answers 401 to a missing or wrong secret. EventBridge retries a 401 for up to 24 hours, so
  fix a secret mismatch inside that window.
- An unknown mail or an event type the server does not record gets a 200 and changes nothing.
- No event stores or logs the recipient address. Rows go after 90 days in the retention sweep, and with
  the account.

## Mail health

Every hour, and at start-up, the server reads the SES account and the 7-day rates from `mail_log`. The job
is off when mail is off.

🔑 **IAM permissions** of the sending user:

| Action | Used for |
|---|---|
| `ses:SendEmail` | Sending, on the mail domain identity and the configuration set |
| `ses:GetAccount` | The hourly account status and 24-hour quota read |
| `ses:DeleteSuppressedDestination` | Staff's Clear Bounce, which takes the address off the account suppression list |

🚨 **Alerts** go to every admin as an urgent message, and to `STAFF_ALERT_EMAIL` when set:

| Condition | Alert |
|---|---|
| Status is not `HEALTHY`, or sending is off | Once per different status. Re-arms when healthy |
| Hard bounces reach 2.5% of 7-day mail | Once. Re-arms below 2.5% |
| Complaints reach 0.05% of 7-day mail | Once. Re-arms below 0.05% |

- A rate needs 200 mails in the window. Under that, it is not measured and its alert state stays as it is.
- A failed SES read is logged and alerts nothing. The report keeps the last good read and its time.
- `GET /api/mail/report?days=N` (admin, default 30, max 90) returns per-day counts, both rates with
  Amazon's review (5%, 0.1%) and pause (10%, 0.5%) limits, the last SES status, and the last 24 hours'
  sends against the quota.

## Storage report

Every hour, and at start-up, `utils/storageCheck` measures the disks and the directories. It stores one
set of rows per UTC day in `storage_days` (`day`, `name`, `bytes`, `files`, `measured_at`). A run replaces
the rows it measured for its day. The job never throws.

- **Disks.** `fs.statfs` on three roles: storage root, data directory, and the local backups directory (`app`;
  its nearest existing parent until the first backup makes it). Roles on one device report once, with an id that joins the roles: `storage+data+app`.
  Each disk stores `disk:<id>:total` and `disk:<id>:used`.
- **Parts.** Bytes and file count for `worlds`, `thumbnails`, `pending`, `avatars`, `event-posters`,
  `supporter-private`, `backups`, and `database` (the file with its WAL). The walk is asynchronous. A
  missing directory counts as empty. A walk that fails writes nothing, so the part keeps its last row.
- `GET /api/storage/report?days=N` (admin). `days` is a whole number from 1 to 365 (`REPORT_MAX_DAYS`,
  default 30); anything else is a 400. It returns:
  - `disks`: `id`, `paths`, `total`, `used`, `free`, `usedFraction`, read at request time.
  - `parts`: by name, `bytes`, `files`, `measuredAt` from the newest stored row; null if never measured.
  - `vacuumFits`: free space on the database's filesystem is at least twice the database file. SQLite
    documents up to twice the file for a `VACUUM`. The WAL does not count.
  - `days`: newest first, one entry per UTC day, today included: `{ day, values, downloads }`.
    `values` is keyed by every part name, plus every other stored name in the window (the disk rows,
    and later `r2:<bucket>`), the same keys on every day. Each value is `{ bytes, files }`, or null when
    that day has no row for the name: a gap is null, never zero. `downloads` is the day's sum of
    `world_download_days`, 0 with none.
  - `forecast`: by disk id, `{ daysUntilFull }`. A least-squares line through the daily
    `disk:<id>:used` values of the last 30 UTC days, read at today and run out to the disk's total now.
    A whole number rounded down. Null with fewer than 7 measured days in that window, or when the line
    does not rise. It does not depend on `?days`.

The local backups directory is `BACKUPS_DIR` in `config/paths`.

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

## Publishing a Supporter Mascot

**From the app (the normal path).** Sign in as an admin, open the Mascot tab, and select **Publish**. Turn on **Supporter-Only**, then select **Publish Supporter-Only**.

- `POST /api/worlds` takes `supporterOnly: true` from an admin only. Anyone else gets 403, and nothing is written.
- The content goes straight to `supporter-private`. One transaction creates the row Supporter-only, pinned and approved. A failed step rolls back the row and removes both files.
- The create reply carries no `contentData`.
- A contest entry can't be Supporter-only (400).

**Revisions.** The admin's Mascot links to the listing after the publish. Publish again: the dialog preselects the linked listing under **Or update existing**. The update keeps the listing Supporter-only, writes to `supporter-private`, and bumps the revision. Installed copies update at their next entitlement check. Staff edits never wait for Listing Review.

- ⚠️ **Publish as new** with the switch off makes a second, public listing. Keep the preselected listing for a revision.

**Fallback script.** If the app path fails, export the Mascot from the Mascot tab, copy the `.webp` to the server, and run:

```bash
cd /srv/formamorph/app && npm run publish-supporter -- /tmp/mascot.webp --author <admin username> [--name <name>] [--thumbnail <image>] [--description <text>]
```

- Same create step as the route: Supporter-only, pinned and approved in one transaction, content in `supporter-private`.
- The thumbnail is the card's Initial look, or `--thumbnail`. Either is re-encoded, so the card in the export's metadata never reaches the public thumbnail.
- It refuses an author who is not an admin, a file with no Mascot card, and a card over the 10 MB cap.
- ⚠️ It does not check for Morphie layers, as the app's publish does. Use original art only.
- A script listing takes revisions the same way: publish the edited Mascot from the app as the listing's author, and pick the listing under **Or update existing**.
- Delete the copied `.webp` afterwards. It holds every layer unwatermarked.

## Reading a leaked image

Each account's Supporter downloads carry an invisible watermark: a random 32-bit mark number, kept per
account in `watermark_marks`. To find who a leaked image was made for, copy it to the server and run:

```bash
cd /srv/formamorph/app && npm run read-leak -- /tmp/leak.png
```

| Output | Meaning |
|---|---|
| `Mark 0x…: account <id> (<username>)` | The copy was made for that account |
| `Mark 0x…: no account holds it` | A real mark, but its account has since been erased |
| `No mark found` | No watermark in this image |

- **Image library:** [`sharp`](https://github.com/lovell/sharp) 0.35 (libvips), which decodes the leaked
  file. The mark itself, in `src/utils/watermark.js`, needs no library.
- **Where it lives:** the robust part moves only the blue-yellow axis, which the eye barely resolves at a
  16 px pattern. Luma PSNR is at least 46 dB; RGB PSNR is 36.6–38.6 dB. A luma mark strong enough for
  the same robustness showed as a checker on flat fills.
- **What it survives:** measured on Morphie's base and on the composed Mascot (all layers over a
  background), with 6 marks over 3 rigs and 3 backgrounds:

  | Attack | Reads |
  |---|---|
  | Shift of 1–3 px on either axis, then WebP q50 or JPEG q75 | 72 of 72 each |
  | WebP q50, then a 50% downscale | 12 of 12 |
  | WebP q50, a 50% downscale, or a 20% crop, alone | always |
  | A screenshot inside a larger window, or at twice the size | always |

- **Exact copies:** every layer's untouched download reads back, down to a 1.5k-pixel face part. Measured
  over 100 random marks on all 26 of Morphie's layers (2,600 copies) with no miss.
- **Floor:** one layer read on its own survives those attacks from about 310k opaque pixels, as Morphie's
  base (474k) does. Smaller layers, such as a face part, read back only as the exact file. A leaked rig is
  still traced through its base layer.
- **Not survived:** ⚠️
  - A 50% downscale *then* WebP q50 (0 of 12): WebP stores chroma at half size, which leaves a halved
    copy's mark no room.
  - Two WebP q50 saves read only 4 of 12.
  - Rotation and heavy edits.
- **Cost:** embedding all 26 layers of a rig takes about 0.5 s. A read takes about 0.2 s when it finds the
  mark at full size, and up to 1–2 s when it must search for the scale, as every unmarked image does.
- **False reads:** CRC-32 and a pilot check put an unmarked image reading as marked near one in four
  billion.

## Scrambled layers

Supporter layers leave the server as shuffled tiles. `src/utils/scramble.js` is the server half; the client
copies the inverse. Both test against `tests/fixtures/scramble-vectors.json`.

- **Format version 1:** pad the layer with transparent pixels to a multiple of 8 on each axis, cut it into
  a fixed 8x8 grid, and move the tiles by a permutation with no fixed point. Layers under 8 px pad up too.
- **Permutation:** Sattolo's shuffle over `mulberry32(seed)`, seed a 32-bit unsigned integer. Destination
  tile `i` holds source tile `permutation[i]`.
- **Route contract:** the file must travel lossless, with `{ seed, version, sourceWidth, sourceHeight }`
  beside it. The client crops to the source size after it unscrambles.
- **Changing the format:** bump `VERSION`, keep the old vectors, and add new ones.

## Per-account processing

`src/utils/supporterProcessing.js` runs on the gated route and the staff review route.

- **What it touches:** every `data:image/...;base64,` string in the content, at any depth. Each becomes
  `{ dataUrl, seed, version, sourceWidth, sourceHeight }` in the same place: marked with the account's mark,
  scrambled, encoded as lossless PNG. Other content, and an image that will not decode, passes through.
- **Seed:** HMAC-SHA256 of `supporter-scramble-v1|userId|listingId|revision`, keyed by `JWT_SECRET`. One
  seed per account and revision, shared by all layers.
- **Cache:** one file per account and revision in the private area, `processed-<listing>-r<revision>-<user>.json`.
  The first miss after a revision change deletes that listing's older files. The review route never caches.
- **Cost:** a cold Morphie-sized request (26 layers plus the Initial render) takes about 1.5 s.

## Hidden Gems

💎 Up to 3 well-liked, low-download worlds, flagged `hidden_gem: true` on `GET /api/worlds` rows.

| Table | Holds |
|---|---|
| `world_download_days` | One row per world per UTC day: `count` of downloads from all three content routes |
| `hidden_gem_rotations` | One row per rotation: `rotated_at` |
| `hidden_gem_picks` | The worlds each rotation picked |

- **Job:** `rotateHiddenGems` (`src/utils/rotateHiddenGems.js`) runs at boot, then hourly. It rotates only
  when the newest rotation is 12 h old or older, so a restart never reshuffles early. A failure is logged
  as `Hidden Gem rotation failed:` and the next tick retries.
- **Pruning:** the same job deletes rotations older than 7 days, except the newest.
- **Rules and constants:** `src/config/hiddenGems.js`, and the server spec at `docs-internal/specs/hidden-gems/spec.md`.

### Backfilling the download log (once)

Run this right after the deploy that adds the tables. It rebuilds `world_download_days` from the backups
since 2026-09-06, so the first rotation scores 60 days of downloads.

- Each gap between two backups is spread evenly over its UTC days. Worlds deleted since are skipped.
- It adds to buckets the live log already has. A nightly `db-<date>` file counts as taken at 04:17 UTC.
- `--write` stores the buckets, replaces every rotation with a fresh one, and records the run in the
  internal `hidden_gem_backfill` setting. A second run is refused.

The commands below are PowerShell. They pass every backup in time order, up to and including `pre-deploy-83fff6d-…`,
the backup of the deploy that added the tables. A later backup would count downloads the live log
already holds.

1. Dry run. Check that the last file is that backup, then read the totals:

   ```powershell
   ssh formamorph-api -i "$HOME\.ssh\id_ed25519_formamorph" -o IdentitiesOnly=yes 'cd /srv/formamorph/app && F=$(ls backups | grep -E ''^(db-[0-9-]+\.db(\.zst)?|pre-deploy-.+\.db)$'' | sed -E ''s/^db-([0-9-]+)/\1T04-17 &/; s/^pre-deploy-[0-9a-f]+-(.*)$/\1 &/'' | sort | sed ''s/^[^ ]* /backups\//'' | sed "/pre-deploy-83fff6d-/q") && echo $F | tr '' '' ''\n'' | tail -3 && npm run -s backfill-download-days -- $F'
   ```

   Expect `worlds=<n> buckets=<n> downloads=<n> skipped=<n>`.

2. Write. Same command with `--write` after `--`. Expect the totals again and `picks=<ids>`, or `picks=none`.
   Record both lines in the deploy log entry.

## Cost

| Item | Per month |
|---|---|
| Hetzner CX22 (Helsinki, IPv4 and 20 TB traffic included) | €3.79 before VAT |
| Cloudflare R2 | $0 under 10 GB, then $0.015/GB. Back under the free tier since the `preview_data` drop |
| Cloudflare DNS | $0 |
| Domain formamorph.ai | about $70 to $100 per year |

## Deploy log

- **2026-11-09** — deployed `9b9331c`: the usage report measures accounts against the budget week, and the
  live hosted run shows cached tokens and has JSON output. All 3,508 tests passed in 67 s (75 s wall). No
  backup: no schema step. Service active with zero restarts, boot logged `Server running on port`, public
  route 200. npm again skipped the `better-sqlite3` install script; the prebuild loads.
- **2026-11-07** — deployed `40ebe93`: the usage report measures each account against its latest tier, so a
  mid-week upgrade no longer reads as over budget. All 3,502 tests passed in 51 s (53 s wall). No backup: no
  schema step. Service active with zero restarts, boot logged `Server running on port`, public route 200.
  npm 11 skipped the `better-sqlite3` install script; its bundled `linux-x64` prebuild loads, so nothing broke.
- **2026-11-07** — deployed `3856877`: the backfill reads older `-NNNZ` pre-deploy names. All 3,501 tests passed
  in 54 s (55 s wall). No backup: no schema step. Service active with zero restarts, boot logged
  `Server running on port`, public route 200. Hidden Gems backfill ran once, list ending at
  `pre-deploy-83fff6d-2026-11-07T20-04-16.078Z.db`: `worlds=734 buckets=23663 downloads=97453 skipped=30`,
  then `picks=` 3 worlds. The catalog flags those 3.
- **2026-11-07** — deployed `2e835ce`: Formamorph AI telemetry (refusal totals, reservation and client version
  on usage rows), active installs (daily send, month close) and the server half of Hidden Gems. All 3,500 tests
  passed in 42 s (43 s wall). Backup `backups/pre-deploy-83fff6d-2026-11-07T20-04-16.078Z.db`, integrity `ok`.
  Boot applied `hostedUsageTelemetry`, `hiddenGems`, `hostedRefusals`, `activeInstalls`, `activeInstallTotals`
  and `indexes`, all additive. Service active with zero restarts, boot logged `Server running on port`, public
  route 200. Published the privacy policy as `acceptance_version=5` with re-accept. The Caddyfile has no `log`
  directive, so Caddy keeps no access log. `active_installs` is still off. The Hidden Gems backfill is not run:
  its dry run refuses the two September backups named with `-NNNZ` milliseconds.
- **2026-11-05** — deployed `83fff6d`: staff read `account_likes` on contest entries in the catalog. All 3,410 tests
  passed in 53 s wall time. No schema step, so no backup. Service active with zero restarts, boot logged
  `Server running on port`, public catalog 200 with no `account_likes` on any guest row.
- **2026-11-05** — deployed `9dbdfd2`: the admin Formamorph AI usage report. All 3,387 tests passed in 57.2 s wall
  time. No schema step, so no backup. Service active with zero restarts, boot logged `Server running on port`,
  public route 200.
- **2026-11-05** — deployed `1e28243`: the routes also answer the doubled offer count address 3.6.0 builds call,
  until the next release. All 3,374 tests passed in 57.2 s wall time. No schema step, so no backup. Service active
  with zero restarts, boot logged `Server running on port`, public route 200.
- **2026-11-05** — deployed `346e858`: Formamorph AI usage rows now record time to first token, the longest gap
  between tokens, the finish reason and a fixed failure cause. All 3,373 tests passed in 80.7 s wall time. Backup
  `backups/pre-deploy-cea5aa6-2026-11-05T00-14-33.306Z.db`, integrity `ok`. Boot applied
  `hostedUsageDiagnostics`, additive, so a rollback needs no restore. Service active with zero restarts, boot
  logged `Server running on port`, public route 200. The journal shows every 3.6.0 offer-count call answering 404
  on a doubled `/api/api/funnel` path, and `funnel_totals` is empty.
- **2026-11-03** — deployed `cea5aa6`: the Formamorph AI proxy, metering, limits and admin routes, the third
  Supporter tier, Patreon tier names and pledge freshness, the network kind and likes marker, offer totals, and
  the stricter Avatar license gate. All 3,358 tests passed in 40.8 s wall time. Backup
  `backups/pre-deploy-d3c4670-2026-11-03T22-27-54.790Z.db`, integrity `ok`. Boot applied `tables`, `networkKind`,
  `supporterTop`, `hostedGrants` and `indexes`. `supporterTop` rebuilds `patreon_links` with the same columns
  and a wider CHECK, so old code still runs on it. Added
  `PATREON_SUPPORTER_TOP_TIER_ID` on the server. Published the privacy policy as `acceptance_version=4` with
  re-accept. The policy states 30-day usage retention, so `hosted_ai` must set `retentionDays` to 30. The proxy
  stays paused until the launch checklist env keys are set. Service active with zero restarts, boot logged
  `Server running on port`, network lists downloaded, public route 200.
- **2026-10-28** — deployed `d3c4670`: the mascot listing kind, staff pins, and Supporter-only listings with
  the gated route, per-account watermark, tile scramble, revocation and the publish script. All 2,858 tests
  passed in 51.8 s wall time. Backup `backups/pre-deploy-a0c0689-2026-10-28T13-22-15.290Z.db`, integrity
  `ok`. Boot applied `tables`, `pinnedAt` and `supporterContent`, all additive. `npm ci` warned that the
  `better-sqlite3` install script did not run; the bundled `linux-x64` prebuild loads, so no build is
  needed. Service active with zero restarts, boot logged `Server running on port`, public route 200.
- **2026-10-27** — deployed `a0c0689`: usernames accept single inner spaces, with a folded `username_key`
  for every name lookup and rename flags cleared under the spaced rule. All 2,562 tests passed in 27.0 s
  wall time. Backup `backups/pre-deploy-25c7d7b-2026-10-27T14-16-46.072Z.db`, integrity `ok`. Boot applied
  `usernameKey` and `indexes`. The step is additive, so old code runs on the new schema; only the cleared
  flags need the backup to undo. Service active with zero restarts, boot logged `Server running on port`,
  public route 200.
- **2026-10-27** — deployed `25c7d7b`: listing review with pending updates and trusted authors, feedback
  questions, numbers, links, mentions and guest reads, the username character rule with flagged renames,
  and an updated bundled fingerprint list. All 2,503 tests passed in 31.9 s wall time. Backup
  `backups/pre-deploy-8ea2778-2026-10-27T12-32-51.262Z.db`, integrity `ok`. Boot applied `feedbackQuestions`,
  `acceptedAnswer`, `moderationState`, `auditTarget`, `trustedAt`, `feedbackNumber` and `usernameRename`.
  `feedbackQuestions` rebuilds the `feedback` table, so a rollback needs the backup restored. Service active
  with zero restarts, boot logged `Server running on port`, public route 200.
- **2026-10-23** — OS update, no code change: `apt-get upgrade` took systemd to 259.9, Node to 24.22.1, Caddy
  to 2.11.7, plus snapd and netplan. `cloud-init` and `tmux` stayed held back. The API and the other flagged
  services restarted; boot logged `Server running on port`, public routes 200. A reboot then loaded kernel
  7.0.0-38; the API came back active with zero restarts, no failed units, public routes 200.
- **2026-10-22** — deployed `8ea2778`: an updated bundled fingerprint list, no code change. All 2,105 tests
  passed in 34.6 s wall time. No schema, policy, or env change, so no backup. Service active with zero
  restarts, boot logged `Server running on port`, public route 200.
- **2026-10-17** — deployed `050dc8d`: timed suspensions with an optional end, the boot and hourly expiry
  sweep, and a logged audit entry for every lift. All 2,105 tests passed in 22.3 s wall time. Backup
  `backups/pre-deploy-358550b-2026-10-18T04-27-19.948Z.db`, integrity `ok`. Boot applied `suspensionEnd`,
  which added `users.suspended_until`; the step is additive, so a rollback needs no restore. Service active
  with zero restarts, boot logged `Server running on port`, public route 200.
- **2026-10-17** — deployed `358550b`: an updated bundled fingerprint list, no code change. All 2,056 tests
  passed in 31.1 s wall time. No schema, policy, or env change, so no backup. Service active with zero
  restarts, boot logged `Server running on port`, public route 200.
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
