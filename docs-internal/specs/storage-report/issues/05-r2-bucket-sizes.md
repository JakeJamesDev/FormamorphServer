# 05: R2 bucket sizes in the report

Status: ready-for-agent
Blocked by: 01, 04
Recommended model: Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Reasoning effort: medium

One outbound read added to the job from ticket 01. The SES account read in the mail health job is the pattern.

## What to build

An admin sees the size and object count of both R2 buckets in the storage report, beside the 10 GB free tier, with the time of the last read. Ticket 04 ruled for the Cloudflare API. The token needs only **Account Analytics: Read**. The spec's Open Items give the query shape that worked and the row freshness (about 30 minutes).

## Acceptance criteria

- [ ] The storage check job reads both buckets every hour with one query and stores `r2:<bucket>` rows in `storage_days` for the current day.
- [ ] Size is `payloadSize + metadataSize` from the newest row of each bucket.
- [ ] A failed read keeps the last good value and its timestamp, and the job still completes its disk and directory work.
- [ ] With no token in the env, the job skips R2 and the report's `r2` is null.
- [ ] The report adds `r2`: per bucket `bytes`, `objects`, and `checkedAt`, plus `freeTierBytes`. The free tier is a constant in a config module.
- [ ] The token (Account Analytics: Read only) comes from one new env key. The account id and bucket names come from the R2 keys already in the server env. The token never appears in a log line or a response.
- [ ] Tests inject the fetch. Cases: both buckets read, a failed read, a missing token, and a bucket with no rows.
- [ ] `docs-internal/server.md` lists the new env key and says it goes in the server env file by hand before this ticket deploys.
