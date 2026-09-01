# Domain glossary

The words the code uses, so a reader and a reviewer mean the same thing by them.

## Content

| Term | Meaning |
|---|---|
| **Listing** | One published item in the workshop: a world, a character, or a dictionary. Stored in the `worlds` table whatever its `kind`. |
| **Kind** | Which of the three a listing is. Defaults to `world` on every list endpoint, so a client that never heard of kinds sees only worlds. |
| **Author** | The account that published a listing. Owns its edits, its changelog, and the comments on it. |
| **Changelog** | A listing's author-maintained update history, one entry per update, sorted by the author's own entry date. |
| **Comment** | A reader's remark on a listing. Editable and deletable by its own author, deletable by the listing's author and by staff. |
| **Image asset** | An uploaded image served back by filename: a listing's thumbnail, an account's avatar, or an event's poster. |

## Moderation

| Term | Meaning |
|---|---|
| **Staff** | Any account with moderation powers: `mod`, `dev`, or `admin`. Staff moderate the room, not each other. |
| **Quarantine** | A listing hidden from everyone but its author and staff, deleted when its deadline passes unless staff release it. The author gets one grace extension per episode. |
| **Report** | A private note from a reader to staff about a listing, a comment, or a profile. Resolved as actioned or dismissed; the reporter is told which. |
| **Feedback** | A public bug report or suggestion thread, with a status, replies, and votes. Distinct from a report, which is never public. |
| **Audit log** | The append-only record of what staff did to accounts and to published work. Every name in it is a snapshot, never a join. |

## Events

| Term | Meaning |
|---|---|
| **Event** | A timed community happening with a window, a banner, and a poster: a contest or an announcement. State is read off the window, never stored. |
| **Contest** | An event listings can be published into. A listing enters at most one contest, on the day it appears. |
| **Entry** | A listing published into a contest. Locked against edits once the contest is being judged. |
| **Podium** | A contest's result: up to three places, each a listing with its name and author snapshotted. |
| **Poster** | An event's presentation band: a color, an image, and a placement that says where the image is framed. |
| **Notice** | A message from the team to one account or to everyone: composed by hand, or generated when a report resolves or an event opens, closes, or announces its podium. |

## Schema

| Term | Meaning |
|---|---|
| **Schema module** | `src/schema/`. Its one interface is `migrate(db)`, which brings any database up to the current shape. |
| **Step** | One entry in the schema module's ordered list. Reads the live schema and changes only what is missing, so a run is safe to repeat. The first step creates every table; the last creates every index. |
