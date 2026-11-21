# Spec: Large Supporter Worlds

Status: done
Status note: Closed 2026-11-20. Tickets 01–02; last landing 19506dd (01 in 4c83ac6, SVG follow-up 6f2ce73). Review: one gap fixed in c5d4920 (undecodable world images now pass through). Gates green on 2026-11-20. Not deployed.
Spec session: large-supporter-worlds — spec

## Problem Statement

Supporters cannot download a large Supporter-only world. Every attempt ends with "The Supporter content request timed out" (report #231, Sunmeadow Town, a Beacon Supporter on a 595 Mbit/s line).

The connection is not the cause. The gated route processes **every** image in the world for the requesting account:

- It decodes each image, embeds the account's watermark, tile-scrambles it, and re-encodes it as lossless PNG.
- It inlines all of them into one JSON body.

Measured on Sunmeadow (284 images, 47 MB):

| | Value |
|---|---|
| Processed size | 858 MB of text |
| Processing time (dev PC) | 49 s |
| `JSON.stringify` of the result | throws `RangeError: Invalid string length` (the V8 cap is about 512 MB) |

The per-account cache never saves, so every request starts over. The client gives up at 60 s before the server fails. The client would also store the result as PNG, so an installed copy would be about 18 times the author's size.

Mascots work, because a Mascot is a few layers and the layers are the content. A world's images are one part among many.

## Solution

A Supporter world carries the account's mark in a **few chosen images**. Every other image goes out byte for byte as the author uploaded it.

- **Marked images:** the world's cover and the 4 largest images of at least 310k pixels. The watermark survives screenshots and re-encodes from that size. Every account gets the same set within a revision.
- **Encoding:** lossless WebP, so the exact-copy band of the mark stays.
- **No scramble for worlds.** If only the marked images arrived scrambled, the scramble would show which images carry the mark.
- **No per-account cache for worlds.** Processing takes seconds, so the server processes each download.
- **Mascots stay as they are:** every layer marked and scrambled, and cached.

Expected for Sunmeadow: about 50 MB per response and about 2 s of processing.

The fix is server-only. A 3.8.0 client passes plain image strings through its unscramble step unchanged, so the reporter's build works once the server is deployed.

## User Stories

1. As a Supporter, I want to download a large Supporter-only world, so that I get the world my tier unlocked.
2. As a Supporter, I want the download to finish in seconds, so that I don't wait or give up.
3. As a Supporter on 3.8.0, I want the fix to work without an app update, so that I can play the world now.
4. As a Supporter, I want the installed world to be about the author's size, so that it doesn't fill my device storage.
5. As a Supporter, I want the world's images to look the same as the author's, so that the art is not degraded.
6. As a Supporter, I want a revision update of a large world to download too, so that I get the author's fixes.
7. As a Supporter who already installed a smaller Supporter world, I want it to keep working unchanged, so that I don't download it again.
8. As a world author, I want my Supporter-only world to stay traceable when someone reuploads it, so that early access keeps its value.
9. As a world author, I want my images delivered exactly as I uploaded them, except the few that carry a mark, so that my world looks the way I made it.
10. As staff, I want a leaked world's cover or large images to name the account that downloaded it, so that I can act on a leak.
11. As staff, I want a screenshot of a marked image to still name the account, so that a leak through screenshots is traceable.
12. As staff, I want a leaker unable to tell from one copy which images carry the mark, so that stripping the mark costs them most of the art.
13. As staff reviewing a flagged Supporter-only world, I want the review download to use the same rule, so that review works for large worlds too.
14. As a Mascot owner, I want Mascot downloads to stay as they are, so that nothing I rely on changes.
15. As the server operator, I want processing to stay within seconds and within memory, so that an install rush doesn't stall other routes.
16. As the server operator, I want no per-account copy of every world in storage, so that disk use doesn't grow with Supporters times worlds.
17. As the server operator, I want the old per-account world cache files removed, so that the dead copies don't hold disk space.
18. As a Supporter of a world with no image of 310k pixels or more, I want the download to work, with only its cover marked.
19. As a Supporter of a world with no cover, I want the download to work, with its largest eligible images marked.

## Implementation Decisions

Rulings from the grill on 2026-11-20:

- **R1. Few marked images.** A Supporter world marks only some images. The server passes every other image through without decoding or re-encoding it. Mascots keep marking every layer.
- **R2. Which images.** The cover plus up to 4 more images: the largest with at least 310k pixels, by width × height. The set is the same for every account in one revision. A world with no eligible image marks only its cover. A world with no cover marks up to 4 eligible images.
- **R3. No scramble for worlds.** Marked world images go out as plain image data URLs. Mascots keep the scramble.
- **R4. Interim.** Sunmeadow stays Supporter-only until the fix ships. Staff reply on #231.
- **R5. Changelog.** The fix rewrites the client changelog line from `2d66c416f` ("Large Supporter worlds now download … on slow connections"). That line names the wrong cause. The client idle timeout from that commit stays.
- **R6. Encoding.** Marked images are lossless WebP.
- **R7. No world cache.** World downloads are processed on each request. Mascots keep the per-account cache.
- **R8. Old installs.** Supporter worlds already installed stay as they are. They pick up the new form on their next revision.
- **R9. Home.** This spec lives in FormamorphServer. The client changelog rewrite is a small client-repo ticket.

Technical decisions:

- **Kind decides the path.** The processing step branches on the listing kind (world or Mascot). The world path never decodes an unmarked image.
- **Size from the header.** Eligibility uses the image's declared width and height from its header (sharp metadata). Ties keep the order the images first appear in the content.
- **Cover.** The cover is the image the world overview's thumbnail points to in the Media List.
- **Ticket 01 rulings (2026-11-20):**
  - The cover is `worldOverview.thumbnail`. It is either a data URL string or `{ mediaId }`, which resolves to `worldOverview.mediaList[mediaId].data`. Both forms are handled.
  - An identical image string in several places counts once toward the 4. Every place where it appears gets the same marked output.
  - Only `data:image/*;base64` strings count. Sound entries, http(s) linked entries and undecodable strings pass through unchanged and are never eligible.
  - A missing, linked or undecodable cover counts as no cover. The 4 are the largest eligible images, excluding the cover.
  - Animated images (GIF, animated WebP) are never marked. An animated cover counts as no cover.
  - SVG images are never marked, so vector art stays vector. An SVG cover counts as no cover.
  - A marked Media Entry drops its `hash` and gets `type: image/webp`. The client re-hashes an entry that has no hash.
  - The deploy cleanup follows the repo's existing one-shot step pattern. It looks up each listing's kind from the database.
- **Mark only.** A marked world image is the source decoded, the account's mark embedded, and the result encoded as lossless WebP. The scramble module is not called.
- **Response shape.** The world's content keeps its shape. A marked image is a plain `data:image/webp;base64,…` string where the source string was. No new fields. 3.8.0 clients already accept this.
- **Processing version.** The world path's output changes, so the processing version changes. Mascot cache files made under the old version are re-made on next request, as today.
- **Cache cleanup.** One run on deploy deletes existing per-account cache files for world listings. Mascot files stay.
- **Staff review route.** It uses the same world path (it already runs uncached).

## Testing Decisions

- **Seam:** the gated route (GET /worlds/:id/supporter-content), like the existing supporter processing tests. Tests assert what the requesting account receives, never internals.
- **World cases:**
  - The cover and the 4 largest eligible images carry the account's mark, read back with the watermark reader.
  - Every other image is byte-identical to the source.
  - A second account gets the same images marked, each with its own mark.
  - No image arrives scrambled.
  - Edge cases: a world with no eligible image (cover only), a world with no cover, and ties in size.
  - A Sunmeadow-scale world (hundreds of large images, built in the test) answers under a response-size bound and a time bound.
  - No cache file is written for a world.
- **Mascot cases:** the existing tests pin the current behavior (every layer marked and scrambled, cached) and must stay green unchanged.
- **Staff review route:** one case for a flagged world under the new rule.
- **Cleanup:** existing world cache files go, and Mascot cache files stay.
- **Prior art:** the gated-route and cache-lifecycle tests for supporter processing, and the watermark read-back fixtures.
- **Bites:** each world assertion fails when the old mark-everything path is reinstated.

## Out of Scope

- Client changes beyond the changelog rewrite. The 60 s idle timeout and the client's PNG re-encode of scrambled Mascot layers stay.
- Re-sending Supporter worlds that are already installed (R8).
- Streaming or chunked delivery. It is not needed at about 50 MB.
- Text or metadata watermarks. World text goes to the AI, and hidden marks in text are trivial to strip.
- Automatic reupload detection on publish. Leak reading stays a manual staff tool.
- Changes to the watermark or scramble algorithms.

## Further Notes

- Lossy WebP was measured and rejected for marked images. Without the scramble it reads the mark back fine, but lossless WebP costs only about 5 MB more per world and keeps the exact-copy band. With the scramble, lossy WebP leaves 5–6 dB worse seams along tile edges.
- Weak spot: comparing two accounts' copies shows which images differ. Marking every image has the same weak spot, so R1 gives up nothing there.
- Report #231's reporter can retry once this is deployed. No app update is needed.
