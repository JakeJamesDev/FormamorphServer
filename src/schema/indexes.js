/**
 * Every index, as `CREATE INDEX IF NOT EXISTS`. Always the last step: an index may name a column that a
 * step adds, and indexing it first throws on every database that step exists for.
 */

const indexNames = (database) => database
  .prepare("SELECT name FROM sqlite_master WHERE type='index'")
  .all()
  .map((row) => row.name);

/**
 * @param {Object} database - The connection to migrate
 * @returns {boolean} Whether any index was created
 */
const apply = (database) => {
  const before = indexNames(database).length;

  // Create indexes for worlds table
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_worlds_name ON worlds(name);
    CREATE INDEX IF NOT EXISTS idx_worlds_author ON worlds(author_id);
    CREATE INDEX IF NOT EXISTS idx_worlds_tags ON worlds(tags);
    CREATE INDEX IF NOT EXISTS idx_worlds_kind ON worlds(kind);
    CREATE INDEX IF NOT EXISTS idx_worlds_quarantine ON worlds(quarantine_expires_at);
    CREATE INDEX IF NOT EXISTS idx_worlds_contest ON worlds(contest_event_id);
  `);

  // Both directions are asked for: the catalog counts a listing's likes, and a reader's own are looked up
  // in a batch to fill in every heart on a page at once.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_world_likes_world ON world_likes(world_id);
    CREATE INDEX IF NOT EXISTS idx_world_likes_user ON world_likes(user_id);
  `);

  // Both directions are asked for: the count on a profile reads one, the notification feed the other.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_follows_followed ON follows(followed_id);
    CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_id);
  `);

  // Create indexes for comments table
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_comments_world ON comments(world_id);
    CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);
  `);

  // Read one listing at a time, newest entry first. That is the only order the changelog is asked for.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_world_changelog_world ON world_changelog(world_id, entry_date DESC);
  `);

  // Create indexes for messages tables
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_recalled ON messages(recalled_at);
    CREATE INDEX IF NOT EXISTS idx_message_states_user ON message_states(user_id);
  `);

  // The sweeper asks for events whose start or end has passed, and the lists ask by type. Placements are
  // read by event for a podium and by world for a listing's badges.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_starts ON events(starts_at);
    CREATE INDEX IF NOT EXISTS idx_events_ends ON events(ends_at);
    CREATE INDEX IF NOT EXISTS idx_event_placements_world ON event_placements(world_id);
  `);

  // The deletion sweeper asks for the accounts whose grace period has run out, and nothing else asks
  // anything of this column.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_users_deletion ON users(deletion_requested_at);
  `);

  // One address, one account — the constraint itself rather than a check the routes remember to make.
  // NOCASE because nobody thinks of their address as case-sensitive, and partial because an account
  // without one is the normal case and SQLite would otherwise index every null. NOCASE folds ASCII only,
  // so two addresses differing solely in the case of a non-ASCII letter still read as two addresses.
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email
      ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;
  `);

  // A link arrives as a token and is looked up by its hash; re-issuing one first deletes what the same
  // account already holds for the same purpose. Nothing asks anything else of this table.
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_account_tokens_hash ON account_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_account_tokens_user ON account_tokens(user_id, purpose);
  `);

  // Create indexes for policy acceptances
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_policy_acceptances_user ON policy_acceptances(user_id);
  `);

  // Create indexes for feedback
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_feedback_reporter ON feedback(reporter_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_type_status ON feedback(type, status);
    CREATE INDEX IF NOT EXISTS idx_feedback_comments_thread ON feedback_comments(feedback_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_feedback_reads_user ON feedback_reads(user_id);
    CREATE INDEX IF NOT EXISTS idx_feedback_votes_thread ON feedback_votes(feedback_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action, id);
  `);

  // Three questions are asked of the signals table and no others: which accounts share a hash, what one
  // account left behind, and which rows are past retention.
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_signals_hash ON signals(address_hash);
    CREATE INDEX IF NOT EXISTS idx_signals_user ON signals(user_id);
    CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);
  `);

  // The queue reads open reports grouped by target. The unique one is the duplicate guard itself, and it
  // is partial so re-filing after a resolution stays allowed.
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_one_open
      ON reports (reporter_id, target_kind, target_id) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS idx_reports_open ON reports (status, target_kind, target_id);
  `);

  return indexNames(database).length > before;
};

module.exports = { name: 'indexes', apply };
