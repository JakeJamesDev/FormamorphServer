# 01: Mark a few images in Supporter worlds

Status: done
Blocked by: None (can start immediately)
Recommended model: Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Reasoning effort: high

A branch in per-account processing by listing kind, plus a selection rule and a one-time cleanup. The Mascot path and its tests stay as they are.

## What to build

A Supporter downloads a large Supporter-only world, such as Sunmeadow Town (284 images, 47 MB), in seconds, at about the author's size. The world's cover and its 4 largest eligible images carry the account's mark. Every other image arrives exactly as the author uploaded it. Mascots download as before. Spec rulings R1–R3, R6–R8.

## Acceptance criteria

- [x] For a world listing, the gated route marks the cover and up to 4 more images: the largest with at least 310k pixels by declared width × height, ties in first-appearance order. A second account gets the same images marked with its own mark. Tests read each mark back with the watermark reader. (`supporterWorldImages.test.js`: marks the cover and the 4 largest; second account; size tie; `read` for every marked image)
- [x] A world with no eligible image marks only its cover. A world with no cover marks up to 4 eligible images. A test covers each case. (cover-only, no-cover, linked-or-undecodable-cover tests)
- [x] Marked world images are plain `data:image/webp;base64,…` strings in lossless WebP, in the source string's place. No world image arrives as a scrambled layer object. The content's shape is otherwise unchanged. ("keeps the shape of the content", no `"seed"` in the response)
- [ ] Every unmarked image is byte-identical to the source. The world path never decodes an unmarked image (a test proves it, for example by counting decodes). (byte identity is tested; the decode proof counts `markLayer` jobs, so a raw sharp decode outside it is not caught)
- [x] World downloads write no per-account cache file. Mascot downloads keep their cache, and the existing Mascot tests pass unchanged. ("writes no cache file"; `supporterProcessing.test.js` untouched and green)
- [x] A world built in the test at Sunmeadow scale (hundreds of 1920×1097 images) answers under a response-size bound of 2× the source and within a time bound. With the old mark-everything path reinstated, the test fails. (250 images; mutation run failed it)
- [x] The staff review content route follows the world rule for a world listing. One test covers it. ("the staff review content route for a world")
- [x] A one-time step on deploy deletes existing per-account cache files for world listings and keeps Mascot files. A test covers both sides. (`npm run clear-world-cache -- --write`; "the one-time cleanup of world cache files")
- [ ] The processing version changes with the world path. (a salt constant is hashed into `PROCESSING_VERSION`; no test pins the change)
- [x] `docs-internal/server.md` "Per-account processing" and "Scrambled layers" describe the world rule. `CONTEXT.md` is updated if its Supporter Copy or processing entries say every image is marked. (both edited; the Watermark entry in `CONTEXT.md` updated)

For you: after deploy, download Sunmeadow Town as a Supporter on 3.8.0 desktop and check that it installs and its art looks right. Reply on #231.

## Landed

**Not verified**

- Decode proof: the test counts `markLayer` jobs (5). It cannot see a sharp decode outside the mark step. The code decodes only inside `markWorldImage`.
- Processing version: a salt constant is hashed in, but no test pins that the version changed.

**For you**

- After deploy, run `npm run clear-world-cache -- --write` once on the server (a dry run without `--write` counts the files first).
- After deploy, download Sunmeadow Town as a Supporter on 3.8.0 desktop and check that it installs and its art looks right. Reply on #231.
- SVG data URLs count as images, so a large SVG can be marked and rasterized to WebP. Say if vectors should be skipped.
- No changelog fragment: the repo config has no changelog entry.
