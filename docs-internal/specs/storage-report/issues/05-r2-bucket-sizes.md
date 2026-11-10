# 05: R2 bucket sizes in the report

Status: done
Blocked by: 01, 04
Recommended model: Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Reasoning effort: medium

One outbound read added to the job from ticket 01. The SES account read in the mail health job is the pattern.

## What to build

An admin sees the size and object count of both R2 buckets in the storage report, beside the 10 GB free tier, with the time of the last read. Ticket 04 ruled for the Cloudflare API. The token needs only **Account Analytics: Read**. The spec's Open Items give the query shape that worked and the row freshness (about 30 minutes).

## Acceptance criteria

- [x] The storage check job reads both buckets every hour with one query and stores `r2:<bucket>` rows in `storage_days` for the current day. (test "reads both buckets with one request"; hourly wiring is ticket 01's job)
- [x] Size is `payloadSize + metadataSize` from the newest row of each bucket. (same test; mutated to payload only, 3 tests failed)
- [x] A failed read keeps the last good value and its timestamp, and the job still completes its disk and directory work. (tests "keeps the last good value…" and "…network call throws or the reply holds errors")
- [x] With no token in the env, the job skips R2 and the report's `r2` is null. (test "skips R2 with no token"; also each of the three R2 keys)
- [x] The report adds `r2`: per bucket `bytes`, `objects`, and `checkedAt`, plus `freeTierBytes`. The free tier is a constant in a config module. (`R2_FREE_TIER_BYTES` in `src/config/storage.js`)
- [x] The token (Account Analytics: Read only) comes from one new env key. The account id and bucket names come from the R2 keys already in the server env. The token never appears in a log line or a response. (tests check the log on 503, thrown fetch, and error replies, and the response body)
- [x] Tests inject the fetch. Cases: both buckets read, a failed read, a missing token, and a bucket with no rows. (`setProbe({ fetch })`)
- [x] `docs-internal/server.md` lists the new env key and says it goes in the server env file by hand before this ticket deploys.

## Landed

**Not verified**
- The real Cloudflare reply. Tests inject the fetch; the query follows the shape ticket 04 proved. The one-request form uses one aliased field per bucket.
- `R2_FREE_TIER_BYTES` uses decimal GB (10 × 1000³). Cloudflare's unit was not checked.

**For you**
- Add `CLOUDFLARE_ANALYTICS_TOKEN` to the server env file before deploy (`docs-internal/server.md`).
- After deploy, check the first hourly run fills `r2` in `GET /api/storage/report` (look at `r2.buckets` and `checkedAt`).
