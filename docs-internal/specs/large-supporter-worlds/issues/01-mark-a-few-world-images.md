# 01: Mark a few images in Supporter worlds

Status: ready-for-agent
Blocked by: None (can start immediately)
Recommended model: Claude Sonnet 5.5 (`claude-sonnet-5-5`)
Reasoning effort: high

A branch in per-account processing by listing kind, plus a selection rule and a one-time cleanup. The Mascot path and its tests stay as they are.

## What to build

A Supporter downloads a large Supporter-only world, such as Sunmeadow Town (284 images, 47 MB), in seconds, at about the author's size. The world's cover and its 4 largest eligible images carry the account's mark. Every other image arrives exactly as the author uploaded it. Mascots download as before. Spec rulings R1–R3, R6–R8.

## Acceptance criteria

- [ ] For a world listing, the gated route marks the cover and up to 4 more images: the largest with at least 310k pixels by declared width × height, ties in first-appearance order. A second account gets the same images marked with its own mark. Tests read each mark back with the watermark reader.
- [ ] A world with no eligible image marks only its cover. A world with no cover marks up to 4 eligible images. A test covers each case.
- [ ] Marked world images are plain `data:image/webp;base64,…` strings in lossless WebP, in the source string's place. No world image arrives as a scrambled layer object. The content's shape is otherwise unchanged.
- [ ] Every unmarked image is byte-identical to the source. The world path never decodes an unmarked image (a test proves it, for example by counting decodes).
- [ ] World downloads write no per-account cache file. Mascot downloads keep their cache, and the existing Mascot tests pass unchanged.
- [ ] A world built in the test at Sunmeadow scale (hundreds of 1920×1097 images) answers under a response-size bound of 2× the source and within a time bound. With the old mark-everything path reinstated, the test fails.
- [ ] The staff review content route follows the world rule for a world listing. One test covers it.
- [ ] A one-time step on deploy deletes existing per-account cache files for world listings and keeps Mascot files. A test covers both sides.
- [ ] The processing version changes with the world path.
- [ ] `docs-internal/server.md` "Per-account processing" and "Scrambled layers" describe the world rule. `CONTEXT.md` is updated if its Supporter Copy or processing entries say every image is marked.

For you: after deploy, download Sunmeadow Town as a Supporter on 3.8.0 desktop and check that it installs and its art looks right. Reply on #231.
