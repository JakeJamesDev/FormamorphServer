# 01: Flag Avatar Stand-Ins

Status: ready-for-human
Base: 8a4c7b9
Blocked by: None (can start immediately)
Recommended model: Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Reasoning effort: medium

**Parent:** [Avatar Portrait Cards (server part)](../spec.md). Numbered to match the client spec's tickets.

**What to build:** An Avatar listing says whether its thumbnail is the server's stand-in, exactly as an entity listing does. The `model` kind rules gain the placeholder flag. The existing backfill then flags older Avatar rows that carry the stand-in. The stored file stays as it is.

## Acceptance criteria

- [x] Publishing an Avatar with no thumbnail returns `placeholder: true`.
- [x] Publishing an Avatar with a thumbnail returns `placeholder: false`.
- [x] Updating an Avatar with a thumbnail clears the flag.
- [x] The backfill flags existing Avatar rows whose thumbnail is the stand-in, and leaves Avatars with real art alone.
- [x] Dictionaries and worlds still never flag.
- [x] The existing "never flags an avatar" test is replaced by the cases above, at the HTTP level. Each new guard is proven by removing the kind rule and watching it fail.
- [x] Server tests pass. Report the test wall time.
