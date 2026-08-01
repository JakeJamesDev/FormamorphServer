require('dotenv').config();
const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// Create tables
const createTables = () => {
  // Users table
  db.exec(`
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
      -- Bumped to cut every signed-in session loose at once. A token carries the value it was minted
      -- under; the auth middleware refuses one that no longer matches. Without it a stolen token stays good for
      -- its full life no matter what the owner or an admin does about the breach.
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Worlds table
  db.exec(`
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
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (author_id) REFERENCES users (id)
    )
  `);

  // Comments table
  db.exec(`
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      world_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users (id)
    )
  `);

  // Messages table — admin-authored, one-way. `recipient_id` NULL means a broadcast; `recalled_at` is a
  // soft delete that hides it from users while keeping the audit trail. `created_at` is CURRENT_TIMESTAMP
  // so it shares a format with `users.created_at`, which the broadcast visibility rule compares against.
  //
  // `scope` is one escalating choice rather than separate audience/dismissible flags, because pinning
  // something always means everyone gets it: `existing` (accounts that predate it, dismissible), `new`
  // (also later signups, dismissible), `pinned` (also later signups, and cannot be dismissed).
  db.exec(`
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
  db.exec(`
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
  db.exec(`
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

  db.exec(`
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'bug' CHECK (type IN ('bug', 'suggestion')),
      reporter_id TEXT,
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

  db.exec(`
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
  db.exec(`
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
  db.exec(`
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
  db.exec(`
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
  // than it, so following somebody shows what they do next instead of dumping their back catalogue.
  db.exec(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id TEXT NOT NULL,
      followed_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (follower_id, followed_id),
      FOREIGN KEY (follower_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (followed_id) REFERENCES users (id) ON DELETE CASCADE
    )
  `);

  // Append-only record of what was done to accounts and to published work. Every name is a *snapshot*
  // rather than a join: the whole point is that an entry still reads after the world, the comment or the
  // account it describes is gone. Nothing here references another table, and nothing cascades.
  //
  // No delete route exists for this — an audit trail somebody can edit is not one.
  db.exec(`
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

  console.log('Database tables created successfully');
};

/** The value this seeder once defaulted to, and that older setup docs prescribed. Refused on sight. */
const FORBIDDEN_ADMIN_PASSWORD = 'admin123';

/**
 * Seed the first administrator from the environment.
 *
 * There is no default password. A missing or well-known `ADMIN_PASSWORD` aborts the seed rather than
 * quietly creating the one account that can delete the site behind a credential anyone can guess —
 * a silent fallback is indistinguishable from a correct setup until somebody logs in as you.
 *
 * @throws {Error} When `ADMIN_PASSWORD` is unset, too short, or the known-bad value
 */
const createAdminUser = async () => {
  try {
    // Existence first, validation second: on a database that already has its administrator the password
    // is never used, and a deploy that reruns this routinely must not start failing over an env var
    // nothing reads. The rules below guard creation only.
    const existingAdmin = db.prepare('SELECT * FROM users WHERE username = ?').get(process.env.ADMIN_USERNAME || 'admin');

    if (existingAdmin) {
      console.log('Admin user already exists');
      return;
    }

    const password = process.env.ADMIN_PASSWORD;

    if (!password) {
      throw new Error('ADMIN_PASSWORD is not set — refusing to seed an admin account with a default password');
    }

    if (password === FORBIDDEN_ADMIN_PASSWORD) {
      throw new Error('ADMIN_PASSWORD is the well-known setup default — choose a real password');
    }

    if (password.length < 12) {
      throw new Error('ADMIN_PASSWORD must be at least 12 characters');
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Generate UUID for user ID
    const userId = uuidv4();

    // Insert admin user
    db.prepare(`
      INSERT INTO users (id, username, password, email, account_type)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      userId,
      process.env.ADMIN_USERNAME || 'admin',
      hashedPassword,
      process.env.ADMIN_EMAIL || 'admin@example.com',
      'admin'
    );

    console.log('Admin user created successfully');
  } catch (error) {
    // Rethrown, not logged and shrugged off: a swallowed failure here leaves a database that looks
    // seeded and has no owner, or worse, hides the refusal above.
    console.error('Error creating admin user:', error.message);
    throw error;
  }
};

// Create indexes for search functionality
const createIndexes = () => {
  // Create indexes for worlds table
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worlds_name ON worlds(name);
    CREATE INDEX IF NOT EXISTS idx_worlds_author ON worlds(author_id);
    CREATE INDEX IF NOT EXISTS idx_worlds_tags ON worlds(tags);
    CREATE INDEX IF NOT EXISTS idx_worlds_kind ON worlds(kind);
    CREATE INDEX IF NOT EXISTS idx_worlds_quarantine ON worlds(quarantine_expires_at);
  `);

  // Both directions are asked for: the catalog counts a listing's likes, and a reader's own are looked up
  // in a batch to fill in every heart on a page at once.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_world_likes_world ON world_likes(world_id);
    CREATE INDEX IF NOT EXISTS idx_world_likes_user ON world_likes(user_id);
  `);

  // Both directions are asked for: the count on a profile reads one, the notification feed the other.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
  `);

  // Create indexes for comments table
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_comments_world ON comments(world_id);
    CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);
  `);

  // Create indexes for messages tables
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_recalled ON messages(recalled_at);
    CREATE INDEX IF NOT EXISTS idx_message_states_user ON message_states(user_id);
  `);

  // Create indexes for policy acceptances
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_policy_acceptances_user ON policy_acceptances(user_id);
  `);

  // Create indexes for feedback
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_feedback_reporter ON feedback(reporter_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_type_status ON feedback(type, status);
    CREATE INDEX IF NOT EXISTS idx_feedback_comments_thread ON feedback_comments(feedback_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_reads_user ON feedback_reads(user_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_votes_thread ON feedback_votes(feedback_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, id);
  `);

  console.log('Database indexes created successfully');
};

// Initialize database
const initDb = async () => {
  try {
    // Create tables
    createTables();

    // Create indexes
    createIndexes();

    // Create admin user
    await createAdminUser();

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error.message);
    // Nonzero, so a failed seed stops a deploy script instead of reading as success.
    process.exitCode = 1;
  } finally {
    // Close the database connection
    db.close();
  }
};

// Only self-run as a script (`npm run init-db`). Importing this must not initialize or, worse, close the
// shared connection — tests build their schema by calling createTables/createIndexes directly.
if (require.main === module) {
  initDb();
}

module.exports = { createTables, createIndexes, createAdminUser, initDb };
