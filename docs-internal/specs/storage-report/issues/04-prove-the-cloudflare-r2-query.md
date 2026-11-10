# 04: Prove the Cloudflare R2 query

Status: ready-for-agent
Blocked by: None (can start immediately)
Recommended model: Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Reasoning effort: low

One query and a written ruling. No production code.

## What to build

A scratch script runs the `r2StorageAdaptiveGroups` query once against the real account. The result settles which token permission the query needs and how fresh its rows are. The ruling goes into the spec, so ticket 05 knows whether to use the Cloudflare API or the backup-script fallback.

The user creates the token first, with **Account Analytics: Read**, and supplies it as a shell env value. Ask for it before any other work. Never print it and never write it to a tracked file.

## Acceptance criteria

- [ ] The script lives in the gitignored scratch directory and reads the token, account id, and bucket names from the env.
- [ ] The query returns `payloadSize`, `metadataSize`, and `objectCount` for both buckets, or the ticket records the exact error.
- [ ] The ticket's `## Landed` section states the permission that worked, the age of the newest row for each bucket, and the reported sizes beside the sizes from `rclone size`, which the user runs on the server.
- [ ] The spec's Open Items entry for the token test is replaced by the ruling: Cloudflare API, or the fallback when the query fails or the newest row is more than a day old.
- [ ] Ticket 05 is edited to match the ruling.

For you: create the token in the Cloudflare dashboard under My Profile → API Tokens, with the single permission Account → Account Analytics → Read.
