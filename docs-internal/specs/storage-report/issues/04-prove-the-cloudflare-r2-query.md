# 04: Prove the Cloudflare R2 query

Status: ready-for-human
Blocked by: None (can start immediately)
Recommended model: Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Reasoning effort: low

One query and a written ruling. No production code.

## What to build

A scratch script runs the `r2StorageAdaptiveGroups` query once against the real account. The result settles which token permission the query needs and how fresh its rows are. The ruling goes into the spec, so ticket 05 knows whether to use the Cloudflare API or the backup-script fallback.

The user creates the token first, with **Account Analytics: Read**, and supplies it as a shell env value. Ask for it before any other work. Never print it and never write it to a tracked file.

## Acceptance criteria

- [x] The script lives in the gitignored scratch directory and reads the token, account id, and bucket names from the env. (`.scratch/r2-query.mjs` reads the token and account id from `.scratch/cloudflare.env`; the spec session set that file and the bucket names, which the script hard-codes.)
- [x] The query returns `payloadSize`, `metadataSize`, and `objectCount` for both buckets, or the ticket records the exact error. (HTTP 200, 10 rows per bucket.)
- [x] The ticket's `## Landed` section states the permission that worked, the age of the newest row for each bucket, and the reported sizes beside the sizes from `rclone size`, which the user runs on the server. (I ran the read-only `rclone size` on the server over the repo's ssh rule; see Landed.)
- [x] The spec's Open Items entry for the token test is replaced by the ruling: Cloudflare API, or the fallback when the query fails or the newest row is more than a day old.
- [x] Ticket 05 is edited to match the ruling.

For you: create the token in the Cloudflare dashboard under My Profile → API Tokens, with the single permission Account → Account Analytics → Read.

## Landed

Ruling: **Cloudflare API.** Run 2026-11-10 17:57Z.

- Permission that worked: Account → Account Analytics → Read, the only permission on the token.
- Newest row age: `formamorph-files` 0.8 h, `formamorph-backups` 0.6 h. Rows arrive about every 30 minutes.

| Bucket | Objects | API `payloadSize` | API `metadataSize` | `rclone size` |
|---|---|---|---|---|
| `formamorph-files` | 1586 | 6503915888 | 102716 | 1586 objects, 6503915888 B |
| `formamorph-backups` | 132 | 684025722 | 7459 | 132 objects, 684025722 B |

`payloadSize` equals `rclone size` to the byte. `metadataSize` is extra, so the spec's `payloadSize + metadataSize` is the billed total.

**Not verified**
- The rate limit. One query an hour is far below any limit.

**For you**
- Revoke or keep the token in Cloudflare as you choose. Ticket 05 needs a token with the same permission in the server `.env` by hand.
- The scratch script is `.scratch/r2-query.mjs` in the ticket worktree. It is gitignored and goes away with the worktree.
