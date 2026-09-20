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
| **Address key** | How staff name one address inside one listing, to remove the marks that came from it. A digest of the stored address hash with the listing id: it means nothing on another listing, it cannot be read back into the hash, and it is never stored. Null once the sweep has emptied the hash, which leaves the clear-all route as the only way those marks go. |
| **Claim** | Moving an Install's Anonymous Likes onto an account and linking the two, on sign-in. Each mark becomes a Like that keeps the time it was first given, unless the account already likes the listing or wrote it; every mark goes either way. A mark that becomes a Like leaves the listing's total where it was. A skipped one lowers that total by exactly one, which is the point in both cases: an overlap was one person counted twice, and nobody may like their own work. The link is what makes the guest route follow the account's rules afterwards, so signing out is not a second like. |
| **Image asset** | An uploaded image served back by filename: a listing's thumbnail, an account's avatar, or an event's poster. |

## Linked content

| Term | Meaning |
|---|---|
| **Component** | A listing a world can embed: an entity or a dictionary. Never a world, never a model. |
| **Prompt** | A shared prompt preset that names the AI models it works with (`models`, `?model=`). It may offer **Compatibility** for a world, but it is never a component. Not the `model` kind, which is an avatar. |
| **Source** | The published listing a downloaded copy follows. Named by listing id; a republished listing is a new source. |
| **Required dependency** | A source a world's author declared necessary. The world author alone writes the set; the row lives in `listing_dependencies` and survives the source's deletion so resolution can say `not_found`. |
| **Compatibility** | A component's or a prompt's offer of itself for a world, made by its author. Lives in `listing_compatibility`. Never makes the component required. |
| **Review state** | The world author's answer to an offer: `unreviewed`, `approved`, or `declined`. Written by the world author alone. Declined offers are hidden from everyone but the component's author and staff. |
| **Add-on** | A compatible, public, visible component a world's download review may offer. An unlisted component is never one. |
| **Visibility** | `public` or `unlisted`. Unlisted is hidden from discovery, not from existence: the author and staff see it as normal; everyone else gets `404` everywhere except dependency resolution. |
| **Revision** | A per-listing counter bumped by every change to what a download installs. What a client compares to detect a source change; no version is kept behind it. |
| **Dependency resolution** | `GET /api/worlds/:id/dependencies`: a world's required sources as the caller may receive them, `ok` with the listing or `not_found`. The one path an unlisted listing reaches the room by. |

## Moderation

| Term | Meaning |
|---|---|
| **Staff** | Any account with moderation powers: `mod`, `dev`, or `admin`. Staff moderate the room, not each other. |
| **Quarantine** | A listing hidden from everyone but its author and staff, deleted when its deadline passes unless staff release it. The author gets one grace extension per episode. |
| **Report** | A private note from a reader to staff about a listing, a comment, or a profile. Resolved as actioned or dismissed; the reporter is told which. |
| **Feedback** | A public bug report or suggestion thread, with a status, replies, and votes. Distinct from a report, which is never public. |
| **Audit log** | The append-only record of what staff did to accounts and to published work, including a like removed (`like_removed`), an account's likes cleared (`likes_cleared`), and the same two on the guest half of a listing's number (`anonymous_likes_removed`, `anonymous_likes_cleared`). Every name in it is a snapshot, never a join. |

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
| **Podium** | A contest's result: a list of placements, each a listing at a place of 1, 2 or 3 with its name and author snapshotted. |
| **Place** | Where a listing finished. Any number of listings can share one, and a shared place pushes the next down by as many as shared it: 1, 1, 3. |
| **Position** | The order inside a shared place, from 0. The server sets it from publish time, earliest first, so the judge's own list order never reaches the archive. |
| **Poster** | An event's presentation band: a color, an image, and a placement that says where the image is framed. |
| **Notice** | A message from the team to one account or to everyone: composed by hand, or generated when a report resolves or an event opens, closes, or announces its podium. |

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
