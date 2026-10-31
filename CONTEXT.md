# Domain glossary

The words the code uses, so a reader and a reviewer mean the same thing by them.

## Content

| Term | Meaning |
|---|---|
| **Listing** | One published item in the workshop: a world, a character, a dictionary, an avatar, or a prompt. Stored in the `worlds` table whatever its `kind`. |
| **Kind** | Which of the five a listing is. Defaults to `world` on every list endpoint, so a client that never heard of kinds sees only worlds. |
| **Author** | The account that published a listing. Owns its edits, its changelog, and the comments on it. |
| **Changelog** | A listing's author-maintained update history, one entry per update, sorted by the author's own entry date. |
| **Comment** | A reader's remark on a listing. Editable and deletable by its own author, deletable by the listing's author and by staff. |
| **Like** | One account's revocable mark on a listing. The count the room sees is the sum of these and the Anonymous Likes; staff see the likers, and can remove a like or clear an account's likes. |
| **Install** | One copy of the app's local storage, named by a random id it makes once and sends in the `X-Formamorph-Install` header. It names a copy of the app and nothing else: not a person, not a device. Never shown, never put in a URL. |
| **Anonymous Like** | One Install's revocable mark on a listing, given without an account, counted into the number the room sees. It carries the address hash the per-listing cap counts; the hourly sweep empties that hash at the Signal retention period and the like stays. Staff read these beside the account likers, grouped by shared address, and can remove one address group or all of them. |
| **Network Kind** | The kind of network a like came from: `tor`, `vpn` or `hosting`, matched against local lists refreshed daily, Tor first. Stored on account Likes and Anonymous Likes while the `network_kind` setting is on; none when nothing matched or no list is loaded. Staff information only: no count, sort or acceptance reads it. The retention sweep blanks it at the Signal retention period, and a Claim carries it onto the Like. |
| **Flagged Like** | A like from the last 90 days, account or anonymous, that carries a Network Kind. |
| **Burst** | At least `burst_size` different likers on one listing within `burst_window_minutes`, among its likes of the last 90 days. An account counts once; Anonymous Likes count once per address hash, and a blank hash not at all. Overlapping windows merge into one Burst, which starts at its first like. |
| **Likes Marker** | The staff-only sign that a listing's likes are worth a look, worked out on read by `utils/likesMarker`. Its reasons are `burst` (any Burst) and `flagged_share` (at least `likes_marker_min_flagged` Flagged Likes that are at least `likes_marker_share` of the listing's likes of the last 90 days). Nothing acts on it. |
| **Address key** | How staff name one address inside one listing, to remove the marks that came from it. A digest of the stored address hash with the listing id: it means nothing on another listing, it cannot be read back into the hash, and it is never stored. Null once the sweep has emptied the hash, which leaves the clear-all route as the only way those marks go. |
| **Claim** | Moving an Install's Anonymous Likes onto an account and linking the two, on sign-in. Each mark becomes a Like that keeps the time it was first given, unless the account already likes the listing or wrote it; every mark goes either way. A mark that becomes a Like leaves the listing's total where it was. A skipped one lowers that total by exactly one, which is the point in both cases: an overlap was one person counted twice, and nobody may like their own work. The link is what makes the guest route follow the account's rules afterwards, so signing out is not a second like. |
| **Stand-in** | The art the server stores as a thumbnail when a listing is published without one. A Character or Avatar carrying it has `placeholder` set, and a client draws its own art in its place. Not the **Placeholder** account. |
| **Bundled world** | A world the app ships with. Named by its fingerprint, a hash of its long text values, which a migration or a duplicate does not change. The list lives in `src/config/bundledFingerprints.json`, copied in from the client repo at each release. A world publish or update whose content matches one is refused until the author edits the text. |
| **Default Avatar** | A VRM file some build of the app ships as its seeded model. Named by the SHA-256 of its bytes, held in the same list as the bundled worlds. An Avatar publish or update carrying one is refused before the license gate. |
| **Image asset** | An uploaded image served back by filename: a listing's thumbnail, an account's avatar, or an event's poster. |

## Linked content

| Term | Meaning |
|---|---|
| **Component** | A listing a world can embed: an entity or a dictionary. Never a world, never a model. |
| **Prompt** | A shared prompt preset that names the AI models it works with (`models`, `?model=`). It may offer **Compatibility** for a world, but it is never a component. Not the `model` kind, which is an avatar. |
| **Source** | The published listing a downloaded copy follows. Named by listing id; a republished listing is a new source. |
| **Required dependency** | A source a world's author declared necessary. The world author alone writes the set; the row lives in `listing_dependencies` and survives the source's deletion so resolution can say `not_found`. |
| **Compatibility** | A component's or a prompt's offer of itself for a world, made by its author. Lives in `listing_compatibility`. Never makes the component required. |
| **Review state** | The world author's answer to an offer: `unreviewed`, `approved`, or `declined`. Written by the world author alone. Declined offers are hidden from everyone but the component's author and staff. Not the **Moderation state**, which is staff review of a listing. |
| **Add-on** | A compatible, public, visible component a world's download review may offer. An unlisted component is never one. |
| **Visibility** | `public` or `unlisted`. Unlisted is hidden from discovery, not from existence: the author and staff see it as normal; everyone else gets `404` everywhere except dependency resolution. |
| **Revision** | A per-listing counter bumped by every change to what a download installs. What a client compares to detect a source change; no version is kept behind it. |
| **Dependency resolution** | `GET /api/worlds/:id/dependencies`: a world's required sources as the caller may receive them, `ok` with the listing or `not_found`. The one path an unlisted listing reaches the room by. |

## Moderation

| Term | Meaning |
|---|---|
| **Staff** | Any account with moderation powers: `mod`, `dev`, or `admin`. Staff moderate the room, not each other. |
| **Quarantine** | A listing hidden from everyone but its author and staff, deleted when its deadline passes unless staff release it. The author gets one grace extension per episode. |
| **Moderation state** | Where a listing stands in listing review: `approved`, `pending`, or `rejected`, in `moderation_state`. Only approved listings are in circulation; the others are seen by their author and staff alone. Not the **Review state** of an add-on offer. |
| **Pending listing** | A listing waiting for a mod: a new one published while the `listing_review` setting is on, or a **Resubmission**. It answers `404` to everyone but its author and staff. |
| **Pending update** | An edit to an approved listing that waits for a mod. The approved version stays live, unchanged, until the update is approved; a rejected update is dropped. |
| **Resubmission** | An author's edit to a rejected listing, which sends it back to the review queue. Its quarantine deadline keeps running. |
| **Trusted author** | An account an admin marked as trusted (`trusted_at`). Its uploads and updates skip review. Staff count as trusted without the mark. |
| **Auto-approval** | A listing or update that skipped review because of who submitted it. Logged as `listing_auto_approved` with the listing's id, so mods can spot-check it. |
| **Suspension** | An account's status of Suspended. Staff give it 1–90 whole days or no end. Once the end passes the server lifts it by itself, on the next read of the account or in the hourly sweep, and logs `suspension_expired`. |
| **Report** | A private note from a reader to staff about a listing, a comment, or a profile. Resolved as actioned or dismissed; the reporter is told which. |
| **Feedback** | A public bug report, suggestion, or question thread, with a status, replies, and votes. Distinct from a report, which is never public. |
| **Votable board** | The feedback types anyone signed in may reply to and vote on: suggestions and questions. A bug is not one. |
| **Audit log** | The append-only record of what staff did to accounts and to published work, including a like removed (`like_removed`), an account's likes cleared (`likes_cleared`), and the same two on the guest half of a listing's number (`anonymous_likes_removed`, `anonymous_likes_cleared`), and the server's own lift of an ended suspension (`suspension_expired`, no actor). Every name in it is a snapshot, never a join. |

## Leaving

| Term | Meaning |
|---|---|
| **Grace Period** | The seven days between asking for an account to be erased and the erasure. Nothing is hidden or moved during it, and signing in cancels the request outright. |
| **Erasure** | Carrying the request out: one function, one transaction, files removed after it commits. The sweeper and the command-line tool both call it. |
| **Placeholder** | The reserved `[deleted user]` account. Owns the listings and comments of anyone who left but chose to keep their work. No login accepts it, and staff are not shown it. |

## Events

| Term | Meaning |
|---|---|
| **Event** | A timed community happening with a window, a banner, and a poster: a contest or an announcement. State is read off the window, never stored. |
| **Contest** | An event listings can be published into. A listing enters at most one contest, on the day it appears. |
| **Entry** | A listing published into a contest. Locked against edits once the contest is being judged. |
| **Hidden count** | An entry's like count while its contest has no announced results. Left out for everyone but the entry's author and staff, who get it marked private. |
| **Podium** | A contest's result: a list of placements, each a listing at a place of 1, 2 or 3 with its name and author snapshotted. |
| **Place** | Where a listing finished. Any number of listings can share one, and a shared place pushes the next down by as many as shared it: 1, 1, 3. |
| **Position** | The order inside a shared place, from 0. The server sets it from publish time, earliest first, so the judge's own list order never reaches the archive. |
| **Poster** | An event's presentation band: a color, an image, and a placement that says where the image is framed. |
| **Notice** | A message from the team to one account or to everyone: composed by hand, or generated when a report resolves or an event opens, closes, or announces its podium. |

## Supporters

| Term | Meaning |
|---|---|
| **Patreon link** | One row joining an account to a Patreon user ID. Each side links at most once. No member's Patreon token is stored. Unlink and erasure delete it, and the Patreon user ID can then link again. |
| **Tier** | `supporter` ($5), `supporter_plus` ($10), or `supporter_top`. The highest mapped tier in the member's `currently_entitled_tiers`, mapped by Patreon tier ID in the environment. An unmapped tier, or no membership, is no tier; the link stays. |
| **Pledge start** | Patreon's `pledge_relationship_start` for a member with a tier. It can be null. |
| **Patreon webhook** | Patreon's signed call when a membership changes. It sets the tier of the account that links the member; a delete trigger clears it. A call for a Patreon user with no link changes nothing. |
| **Patreon reconcile** | The job that reads the full campaign member list at boot and every hour, and sets every link's tier from it. It repairs a missed webhook. A failed read changes no link. It also refreshes the Tier names. |
| **Tier name** | The Patreon title of a tier, kept by tier key and served at `GET /api/patreon/tier-names`. Null for an unknown or empty title; the client shows its own fallback. A failed refresh keeps the old names, and a request never calls Patreon. |
| **Creator token** | The token pair that reads the member list. It starts from the environment. After its first refresh, the server's settings store holds it, and staff cannot read it. |
| **Supporter Flair** | What a linked account with a tier shows other people. The account turns it off with one toggle. |
| **Mark number** | A random 32-bit number, one per account for good, made the first time the account gets a watermarked copy. Erasure deletes it. |
| **Watermark** | The invisible mark that carries an account's mark number in each image of its Supporter download. |
| **Leak read** | Staff reading the watermark out of a leaked image with `npm run read-leak`, which names the account. |

## Formamorph AI

| Term | Meaning |
|---|---|
| **Formamorph AI** | The hosted AI a Tier includes: a chat-completions proxy at `/api/hosted-ai` that forwards a turn upstream with the server's key. Players never see the key or pick the model. |
| **Hosted state** | What `GET /api/hosted-ai/state` tells an account: tier, state, window, active model, percent used, turns left and acknowledged warnings. Percent and turns only, never a dollar amount. |
| **Grant** | A staff gift of a Tier to an account until an end date. The highest of the pledge and live grants wins; a grant's spend subject is `grant:<id>`. |
| **Spend subject** | Who a call's cost is summed under: the Patreon user ID for a pledge, or `grant:<id>` for a grant. Relinking the membership or erasing and remaking the account keeps the subject and its month. Usage rows have no foreign key to the account; erasure nulls their account and keeps them. |
| **Turn** | The calls one player action makes, named by a turn id the server issues on the first call and the client sends back on the rest. Only a first call is checked against the budget, so a started turn finishes. A turn ends at its time limit or call cap. |
| **Reservation** | The worst-case cost an admitted call records as an `open` usage row before it is forwarded: the estimated prompt plus the capped `max_tokens`. Budget sums count it, so parallel calls cannot all pass the same sum. The call then settles to its real cost. |
| **Pause** | The stop on new Formamorph AI turns once the UTC day's spend, open rows included, reaches the daily ceiling. Admins are alerted once. Started turns finish. An admin can lift it until 00:00 UTC; the next day starts unpaused. |
| **Refusal code** | The `code` a refused Formamorph AI call answers with, such as `budget_exhausted` or `turn_expired`, each with its own status. The list lives in `config/hostedAi` and the client mirrors it. |

## Clients

| Term | Meaning |
|---|---|
| **Build** | Which version of Formamorph is asking, and on what: the `X-Formamorph-Client` header, read into a version and one of `web`, `windows`, `linux`, `mac`, `android`. Logged on every request line. |
| **Version zero** | What a request with no readable build counts as. It is below every minimum, so a build too old to send the header is refused exactly like a build too old for the feature. |
| **Minimum** | The version a route needs, with the feature name to show the player. Below it the server answers `426` with `CLIENT_UPDATE_REQUIRED`; a route with no minimum is untouched. |
| **Route key** | How a minimum names its route: a method, a space, and a path, as in `POST /api/reports`. It covers that path and everything under it, so one entry gates a feature rather than each endpoint. |

## Settings

| Term | Meaning |
|---|---|
| **Setting** | A value staff change without a deploy, stored as JSON in the `settings` table and read live. Every key is declared in `src/config/settings.js` with its default and the check its writes must pass. |
| **Default** | What a key reads as while no one has written it. There is no seeded row, so a setting is empty by default without a row to keep in step with the code. |

## Schema

| Term | Meaning |
|---|---|
| **Schema module** | `src/schema/`. Its one interface is `migrate(db)`, which brings any database up to the current shape. |
| **Step** | One entry in the schema module's ordered list. Reads the live schema and changes only what is missing, so a run is safe to repeat. The first step creates every table; the last creates every index. |
