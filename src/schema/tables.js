/**
 * Every table, in dependency order, as `CREATE TABLE IF NOT EXISTS`.
 *
 * The first step of every run. A fresh database gets the whole current schema from here alone; an existing
 * one gets any table it lacks. What this can never do is change a table that already exists, so a column
 * added after its table shipped has a step of its own in `steps/`, and the drift test in
 * `tests/bootSchema.test.js` proves the two paths meet at the same shape.
 */

const tableNames = (database) => database
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((row) => row.name);

/**
 * @param {Object} database - The connection to migrate
 * @returns {boolean} Whether any table was created
 */
const apply = (database) => {
  const before = tableNames(database).length;

  // Users table
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      email TEXT,
      status TEXT DEFAULT 'normal',
      account_type TEXT DEFAULT 'normal',
      -- The profile image: a filename under the avatars directory, and when it last changed. Null for
      -- an account that has never set one, which is most of them.
      avatar_file TEXT,
      avatar_updated_at TEXT,
      -- When they last opened their notification feed. The feed itself is computed from the follows and
      -- worlds tables, so this one stamp is all the unread state there is.
      feed_seen_at TEXT,
      -- Bumped to invalidate every signed-in session at once. A token carries the value it was minted
      -- under; the auth middleware refuses one that no longer matches. Without it a stolen token stays good for
      -- its full life no matter what the owner or an admin does about the breach.
      token_version INTEGER NOT NULL DEFAULT 0,
      -- When this account asked to be erased, and whether its published work goes with it. Both are
      -- cleared by a login inside the grace period, which is the whole of how a request is cancelled:
      -- nothing is hidden or moved while the stamp stands, so cancelling has nothing to restore.
      deletion_requested_at TEXT,
      deletion_removes_content INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Worlds table
  database.exec(`
    CREATE TABLE IF NOT EXISTS worlds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      author_id TEXT NOT NULL,
      thumbnail_file TEXT NOT NULL,
      preview_data TEXT NOT NULL,
      content_file TEXT NOT NULL,
      downloads INTEGER DEFAULT 0,
      comment_count INTEGER DEFAULT 0,
      tags TEXT,
      spoiler INTEGER DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'world',
      -- Quarantine: hidden from everyone but its author and the admins, and deleted when the deadline
      -- passes unless an admin releases it first. The extension flag is per-episode, cleared on
      -- release, so a listing quarantined again later gets its one grace extension afresh.
      quarantined_at TEXT,
      quarantine_expires_at TEXT,
      quarantine_extended INTEGER NOT NULL DEFAULT 0,
      -- The contest this listing was published into, if any. Set at publish and cleared by a withdrawal,
      -- never moved: a listing enters at most one contest, on the day it appears.
      contest_event_id TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (author_id) REFERENCES users (id),
      -- SET NULL rather than the default: a plain reference would make an event with entries impossible
      -- to delete, which is precisely what the delete route is for.
      FOREIGN KEY (contest_event_id) REFERENCES events (id) ON DELETE SET NULL
    )
  `);

  // Comments table
  database.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      world_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      -- Set the first time the commenter rewrites it, so the thread can say "edited". updated_at is
      -- stamped at insert and so cannot tell an edited comment from an untouched one.
      edited_at TEXT,
      FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users (id)
    )
  `);

  // A listing's author-maintained update history: one row per Changelog Entry. Its own table rather than
  // columns on `worlds`, because the catalog list projection selects the whole listing row — a column here
  // would ride along with every card on every page for something only one open listing ever shows.
  //
  // `entry_date` is the author's own date for the update and is what the list is sorted by; `created_at`
  // only breaks its ties. The two are separate so a history backfilled years late still reads as the
  // history it is rather than as one day of writing. Cascades: the history goes with the listing.
  database.exec(`
    CREATE TABLE IF NOT EXISTS world_changelog (
      id TEXT PRIMARY KEY,
      world_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      entry_date TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE CASCADE
    )
  `);

  // Messages table — admin-authored, one-way. `recipient_id` NULL means a broadcast; `recalled_at` is a
  // soft delete that hides it from users while keeping the audit trail. `created_at` is CURRENT_TIMESTAMP
  // so it shares a format with `users.created_at`, which the broadcast visibility rule compares against.
  //
  // `scope` is one escalating choice rather than separate audience/dismissible flags, because pinning
  // something always means everyone gets it: `existing` (accounts that predate it, dismissible), `new`
  // (also later signups, dismissible), `pinned` (also later signups, and cannot be dismissed).
  database.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      -- Nullable, and SET NULL on delete: a deleted admin's notices stay where they were read. Cascading
      -- would pull a suspension notice out of an inbox while the suspension itself stood.
      sender_id TEXT,
      sender_as TEXT NOT NULL DEFAULT 'team' CHECK (sender_as IN ('team', 'username')),
      recipient_id TEXT,
      subject TEXT NOT NULL,
      body TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'urgent')),
      scope TEXT NOT NULL DEFAULT 'existing' CHECK (scope IN ('existing', 'new', 'pinned')),
      recalled_at TEXT,
      edited_at TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sender_id) REFERENCES users (id) ON DELETE SET NULL,
      FOREIGN KEY (recipient_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // Per-user read/dismiss state. Split from `messages` because one broadcast row has one such state per
  // user; a 1:1 message just never gets more than one.
  database.exec(`
    CREATE TABLE IF NOT EXISTS message_states (
      message_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      read_at TEXT,
      dismissed_at TEXT,
      PRIMARY KEY (message_id, user_id),
      FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // Authored popups shown at publish time. Two fixed rows, created on demand by the admin editor:
  // `upload_gate` (blocking, must be accepted once) and `tag_notice` (advisory, shown whenever one of
  // its tags is present). Neither exists until an admin writes it, so an untouched server gates nothing.
  //
  // `acceptance_version` is what invalidates acceptances. Comparing an acceptance date against the
  // policy's edit date would mean comparing timestamps written in two different formats — the exact
  // trap the message visibility rule already had to work around. A counter has no such ambiguity:
  // requiring re-acceptance bumps it, and an acceptance is current only if it matches.
  database.exec(`
    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL DEFAULT '',
      body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      acceptance_version INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS policy_acceptances (
      policy_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      accepted_version INTEGER NOT NULL,
      accepted_at TEXT NOT NULL,
      -- A decline is recorded too, so an admin can tell "hasn't been asked yet" from "was asked and said no".
      response TEXT NOT NULL DEFAULT 'accepted' CHECK (response IN ('accepted', 'declined')),
      PRIMARY KEY (policy_id, user_id),
      FOREIGN KEY (policy_id) REFERENCES policies (id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // User-filed feedback: bug reports and suggestions. One tree with a `type` branch rather than two
  // parallel systems — a thread, a status and a read-marker mean the same thing on both, and only the
  // vocabulary and who may write differ.
  //
  // `status` and `category` are checked per type, so a suggestion can't be marked 'confirmed' and a bug
  // can't be filed under 'interface'. `reporter_id` is nullable and SET NULL rather than cascading: a
  // suggestion others have voted on and discussed must outlive the account that happened to file it.
  // `locked_at` closes a thread to further replies while leaving it readable.
  database.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'bug' CHECK (type IN ('bug', 'suggestion')),
      reporter_id TEXT,
      -- What the reporter was when they filed it, so a later promotion or demotion never rewrites the
      -- badge on a report they already sent. Null for rows written before the column, which fall back
      -- to the live account type. Mirrors feedback_comments.author_role.
      reporter_role TEXT,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      -- What the client reported about itself (version, platform), shown to the reporter before sending.
      -- Bugs only: a suggestion is about the game, not about the machine it was written on.
      diagnostics TEXT NOT NULL DEFAULT '{}',
      locked_at TEXT,
      -- Set the first time the report is rewritten, so the thread can say "edited". The other reader may
      -- already have read the earlier wording.
      edited_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (type = 'bug' AND status IN ('open', 'need_info', 'confirmed', 'resolved', 'wontfix')
                      AND category IN ('crash', 'ai', 'editor', 'community', 'visuals', 'other'))
        OR
        (type = 'suggestion' AND status IN ('open', 'considering', 'planned', 'declined', 'done')
                             AND category IN ('gameplay', 'writing', 'editor', 'community', 'interface', 'other'))
      ),
      FOREIGN KEY (reporter_id) REFERENCES users (id) ON DELETE SET NULL
    )
  `);

  database.exec(`
    CREATE TABLE IF NOT EXISTS feedback_comments (
      id TEXT PRIMARY KEY,
      feedback_id TEXT NOT NULL,
      -- Nullable for the same reason as the message sender: a deleted author leaves the thread
      -- readable rather than tearing their half of the conversation out of it.
      author_id TEXT,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      -- Set the first time an author rewrites their own comment, so the thread can say "edited".
      edited_at TEXT,
      -- What the author was when they wrote it. Snapshotted rather than joined, so a later promotion or
      -- demotion cannot rewrite the signature on replies somebody has already read. Null on rows written
      -- before this existed, which fall back to the live account type.
      author_role TEXT,
      FOREIGN KEY (feedback_id) REFERENCES feedback (id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL
    )
  `);

  // One row per reader per thread. The badge counts threads holding a comment newer than this, written
  // by somebody else — the same shape as message read-state, kept separate because a thread is read as
  // a whole rather than message by message. Written only for someone the thread badges, so a passing
  // reader of the public queue leaves nothing behind.
  database.exec(`
    CREATE TABLE IF NOT EXISTS feedback_reads (
      feedback_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (feedback_id, user_id),
      FOREIGN KEY (feedback_id) REFERENCES feedback (id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // One vote per account per suggestion. Filing counts as one, so nothing sits at zero that its own
  // author wanted. Cascades on both sides: a deleted account takes its votes with it.
  database.exec(`
    CREATE TABLE IF NOT EXISTS feedback_votes (
      feedback_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (feedback_id, user_id),
      FOREIGN KEY (feedback_id) REFERENCES feedback (id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // One like per account per listing. Separate from the `downloads` counter on the row rather than a
  // second column beside it, because the two answer different questions: downloads count how many people
  // tried something, likes how many were glad they did — and only the second needs to know who, so it can
  // be taken back. Cascades on both sides: a deleted account or listing takes its likes with it.
  database.exec(`
    CREATE TABLE IF NOT EXISTS world_likes (
      world_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (world_id, user_id),
      FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // Who follows whom. The pair is the key, so following twice is a no-op rather than a second row, and
  // both sides cascade — a deleted account leaves neither dangling followers nor a feed of a ghost.
  //
  // The created_at is load-bearing rather than bookkeeping: the notification feed asks for listings newer
  // than it, so following somebody shows what they do next instead of dumping their back catalog.
  database.exec(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      followed_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (follower_id, followed_id),
      FOREIGN KEY (follower_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (followed_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // Timed community happenings: a contest with entries and a podium, or a plain announcement. One table
  // with nullable per-type columns, the same shape `worlds` uses for its kinds — a future type adds
  // columns rather than a table, and every reader keeps working.
  //
  // There is deliberately no status column. Scheduled, active and ended are read off the window, so no
  // writer can leave a row claiming a state its own dates disagree with; `cancelled_at` is the one thing
  // the dates cannot say. Timestamps are written ISO here, and every comparison goes through `datetime()`
  // because the tables this joins against default to CURRENT_TIMESTAMP's format instead.
  //
  // The message ids are what the transitions leave behind: the pinned notice posted at the start, the
  // notice posted at the end, and the results announcement. They are nullable and SET NULL on delete, so
  // recalling or pruning a message never takes the event with it. `results_announced_at` is what makes a
  // contest decided — the stamp, not any one place, so a podium can be edited afterwards without the
  // contest ever un-deciding.
  database.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'announcement' CHECK (type IN ('contest', 'announcement')),
      title TEXT NOT NULL,
      banner_text TEXT NOT NULL,
      body TEXT NOT NULL,
      rules_text TEXT,
      -- The organizer's own presentation for the poster band: a color, and a file the poster route
      -- serves. Both optional — an event with neither renders in the app's default band.
      poster_color TEXT,
      poster_image TEXT,
      -- Where that artwork is framed inside the band: a zoom and a focal point, as JSON. One column
      -- because the three numbers are one choice, and two of them is a placement nothing could render.
      poster_placement TEXT,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      cancelled_at TEXT,
      start_message_id TEXT,
      end_message_id TEXT,
      results_message_id TEXT,
      results_announced_at TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (start_message_id) REFERENCES messages (id) ON DELETE SET NULL,
      FOREIGN KEY (end_message_id) REFERENCES messages (id) ON DELETE SET NULL,
      FOREIGN KEY (results_message_id) REFERENCES messages (id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
    )
  `);

  // A contest's podium: up to three places, one row each. Its own table rather than nine more columns on
  // `events`, because a place is a relationship to a listing and there are three of them — the shape the
  // strict-podium rule is expressible in. Both uniques are the rule: one world per place, and one place
  // per world within a contest.
  //
  // `world_id` is SET NULL on delete while the two names are snapshots, for the reason the audit log
  // snapshots its own: the archive has to still read after the listing is gone.
  database.exec(`
    CREATE TABLE IF NOT EXISTS event_placements (
      event_id TEXT NOT NULL,
      place INTEGER NOT NULL CHECK (place IN (1, 2, 3)),
      world_id TEXT,
      world_name TEXT NOT NULL,
      author_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (event_id, place),
      UNIQUE (event_id, world_id),
      FOREIGN KEY (event_id) REFERENCES events (id) ON DELETE CASCADE,
      FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE SET NULL
    )
  `);

  // Append-only record of what was done to accounts and to published work. Every name is a *snapshot*
  // rather than a join: the whole point is that an entry still reads after the world, the comment or the
  // account it describes is gone. Nothing here references another table, and nothing cascades.
  //
  // No delete route exists for this — an audit trail somebody can edit is not one.
  database.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      -- Plain rowid alias rather than AUTOINCREMENT: nothing is ever deleted here, so ids only ever
      -- climb, and AUTOINCREMENT would add SQLite's own bookkeeping table for a guarantee already held.
      id INTEGER PRIMARY KEY,
      action TEXT NOT NULL,
      -- Who did it, as they were at the time. The id is kept for filtering; the name is what shows.
      actor_id TEXT,
      actor_username TEXT,
      -- What they were at the time. actor_was_admin predates the mod team and cannot tell a mod from an
      -- ordinary account; it is kept so old rows still read, and derived from the role for new ones.
      actor_was_admin INTEGER NOT NULL DEFAULT 0,
      actor_role TEXT,
      -- Who it was done to, when that is somebody other than the actor.
      target_user_id TEXT,
      target_username TEXT,
      -- What it was done to: a kind (world, entity, dictionary, comment, account) and its name.
      target_kind TEXT,
      target_name TEXT,
      -- Enough of what was removed to know what it was, never the whole of it.
      snippet TEXT,
      created_at TEXT NOT NULL
    )
  `);

  // What the room told staff about. Its own private table rather than a branch of `feedback`, because
  // feedback's visibility rules make a suggestion public and nothing here may ever be — the author of
  // reported content must never be able to read who reported them.
  database.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      -- SET NULL rather than CASCADE: a ticket outlives the account that filed it, exactly as feedback does.
      reporter_id TEXT,
      -- Polymorphic on purpose, and so deliberately without a foreign key: the three targets live in three
      -- tables, and a report has to survive its target being deleted, which is one of the ways one ends.
      target_kind TEXT NOT NULL CHECK (target_kind IN ('listing', 'comment', 'profile')),
      target_id TEXT NOT NULL,
      -- What the target was at filing time. Snapshots, for the audit log's reason: the ticket has to still
      -- read after the listing, the comment or the account it describes is gone.
      target_name TEXT,
      target_author_id TEXT,
      target_author_username TEXT,
      target_snippet TEXT,
      -- Where the target sits, when it sits inside something: a comment's listing. What makes the queue's
      -- "view in context" possible at all, since the target id alone names a comment nothing can navigate to.
      target_parent_id TEXT,
      category TEXT NOT NULL,
      details TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
      -- Set only on resolution, and only ever to one of the two answers a reporter is owed.
      outcome TEXT CHECK (outcome IN ('actioned', 'dismissed')),
      -- When the target stopped existing while the report was still open. The report stays open.
      target_gone_at TEXT,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_note TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (reporter_id) REFERENCES users (id) ON DELETE SET NULL,
      FOREIGN KEY (resolved_by) REFERENCES users (id) ON DELETE SET NULL
    )
  `);

  // One row per account action that a ring of accounts would have to repeat: a salted hash of the client
  // address and a coarse browser family, kept for 90 days and then swept. Append-only, and inert on its
  // own — nothing reads it automatically and nothing acts on it. Staff read it to see whether two accounts
  // came from one place; the decision stays theirs.
  //
  // The address is never stored, only `sha256(salt + address)`, so the table links accounts to each other
  // without holding an address anyone could read back. Rotating the salt in the environment unlinks every
  // row at once, which is the emergency lever.
  //
  // The browser family is stored plain because it is a tiebreaker, not an identifier: a household on two
  // browsers reads as two people. Cascades, so erasing an account erases what it left here.
  database.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      -- Plain rowid alias, like the audit log's: rows only ever arrive and expire, never move.
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      event TEXT NOT NULL CHECK (event IN ('signup', 'login', 'like', 'publish', 'comment', 'follow')),
      address_hash TEXT NOT NULL,
      browser_family TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  return tableNames(database).length > before;
};

module.exports = { name: 'tables', apply };
