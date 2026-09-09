const db = require('../config/db');
const { avatarUrlFor } = require('../utils/avatarUrl');
const { badgeRole } = require('../config/roles');

/** The most a feed will hand back at once. Past this it stops being a list of news. */
const FEED_LIMIT = 50;

/**
 * Who follows whom, and what that gets them.
 *
 * There is deliberately no notifications table. A feed row is a *listing*, joined to the follows table
 * and filtered by when the follow started — so the same five updates to one world are one row that keeps
 * getting newer, an author cannot flood anybody by pressing publish repeatedly, and nothing has to be
 * written, fanned out or cleaned up when somebody follows a prolific account.
 *
 * Unread is one timestamp per reader (`users.feed_seen_at`) rather than per row, for the same reason.
 *
 * Every timestamp comparison here goes through `AS_INSTANT`, never raw string ordering. `worlds` holds
 * two formats in one column — SQLite's own on insert, ISO on update — and a raw comparison of
 * `2026-08-01 09:00:00` against `2026-08-01T09:00:00.000Z` is decided by a space sorting below a `T`,
 * which is not a fact about time.
 */

/**
 * One comparable instant, whatever format the column happens to hold.
 *
 * `datetime()` would also normalize both, but it truncates to whole seconds — enough to lose a listing
 * published in the same second the feed was last read. Keeping the milliseconds costs nothing.
 *
 * @param {string} column - The column or parameter to normalize
 * @returns {string} A SQL expression
 */
const AS_INSTANT = (column) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${column})`;
const Follow = {
  FEED_LIMIT,

  /**
   * Start following somebody.
   *
   * Idempotent: the pair is the primary key, so following twice keeps the original date rather than
   * resetting the window and hiding what they published in between.
   *
   * @param {string} followerId - Who is following
   * @param {string} followedId - Who they are following
   * @returns {boolean} Whether this created a new follow
   */
  follow: (followerId, followedId) => {
    const info = db
      .prepare('INSERT OR IGNORE INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, ?)')
      .run(followerId, followedId, new Date().toISOString());

    return info.changes > 0;
  },

  /**
   * Stop following somebody.
   *
   * @param {string} followerId - Who is unfollowing
   * @param {string} followedId - Who they are unfollowing
   * @returns {boolean} Whether there was a follow to remove
   */
  unfollow: (followerId, followedId) => {
    const info = db
      .prepare('DELETE FROM follows WHERE follower_id = ? AND followed_id = ?')
      .run(followerId, followedId);

    return info.changes > 0;
  },

  /** Whether one account follows another. */
  isFollowing: (followerId, followedId) => Boolean(
    followerId && db
      .prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followed_id = ?')
      .get(followerId, followedId)
  ),

  /** How many accounts follow this one. Public; who they are is not. */
  followerCount: (userId) => db
    .prepare('SELECT COUNT(*) AS count FROM follows WHERE followed_id = ?')
    .get(userId).count,

  /**
   * Who somebody follows, newest first.
   *
   * Your own list only — a reader may see and manage who *they* follow, and nobody sees anybody else's.
   *
   * @param {string} followerId - Whose list
   * @returns {Array<Object>} `{ id, username, avatarUrl, role, followedAt }`, newest follow first
   */
  following: (followerId) => db.prepare(`
    SELECT u.id, u.username, u.avatar_file, u.account_type, f.created_at
    FROM follows f
    JOIN users u ON u.id = f.followed_id
    WHERE f.follower_id = ?
    ORDER BY f.created_at DESC, u.username COLLATE NOCASE ASC
  `).all(followerId).map((row) => ({
    id: row.id,
    username: row.username,
    avatarUrl: avatarUrlFor(row.avatar_file),
    role: badgeRole(row.account_type),
    followedAt: row.created_at
  })),

  /**
   * What the accounts somebody follows have published or updated since they started following them.
   *
   * One row per listing, which is what makes repeated updates a single entry that keeps moving up rather
   * than a pile. A listing is `published` when it first appeared after the follow began and `updated`
   * otherwise — the same row either way, so an author revising something they posted last year reads as
   * an update rather than as news.
   *
   * Quarantined and unlisted listings are absent: neither is in circulation on its own, and a feed row
   * pointing at a 404 is worse than no row.
   *
   * @param {string} followerId - Whose feed
   * @param {Object} [options] - `{ limit }`
   * @returns {Array<Object>} Feed rows, newest activity first
   */
  feed: (followerId, { limit = FEED_LIMIT } = {}) => db.prepare(`
    SELECT w.id, w.name, w.kind, w.updated_at,
           ${AS_INSTANT('w.created_at')} AS created_instant,
           ${AS_INSTANT('f.created_at')} AS followed_instant,
           u.id AS author_id, u.username AS author_username, u.avatar_file AS author_avatar_file,
           u.account_type AS author_account_type
    FROM follows f
    JOIN worlds w ON w.author_id = f.followed_id
    JOIN users u ON u.id = w.author_id
    WHERE f.follower_id = ?
      AND w.quarantined_at IS NULL
      AND w.visibility = 'public'
      AND ${AS_INSTANT('w.updated_at')} > ${AS_INSTANT('f.created_at')}
    ORDER BY ${AS_INSTANT('w.updated_at')} DESC, w.id ASC
    LIMIT ?
  `).all(followerId, limit).map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind || 'world',
    // What happened, as far as this reader is concerned: something that did not exist when they followed
    // is news; something that did is a revision.
    event: row.created_instant > row.followed_instant ? 'published' : 'updated',
    at: row.updated_at,
    author: {
      id: row.author_id,
      username: row.author_username,
      avatarUrl: avatarUrlFor(row.author_avatar_file),
      role: badgeRole(row.author_account_type)
    }
  })),

  /**
   * How much of the feed is new since it was last opened.
   *
   * Counted with the same rule the feed itself uses, so the badge and the list can never disagree.
   *
   * @param {string} followerId - Whose feed
   * @param {string|null} seenAt - Their `feed_seen_at`, or null for never opened
   * @returns {number} Unread rows
   */
  unreadCount: (followerId, seenAt) => db.prepare(`
    SELECT COUNT(*) AS count
    FROM follows f
    JOIN worlds w ON w.author_id = f.followed_id
    WHERE f.follower_id = @followerId
      AND w.quarantined_at IS NULL
      AND w.visibility = 'public'
      AND ${AS_INSTANT('w.updated_at')} > ${AS_INSTANT('f.created_at')}
      AND (@seenAt IS NULL OR ${AS_INSTANT('w.updated_at')} > ${AS_INSTANT('@seenAt')})
  `).get({ followerId, seenAt: seenAt ?? null }).count,

  /** Stamp the feed as read, up to now. */
  markSeen: (followerId) => {
    db.prepare('UPDATE users SET feed_seen_at = ? WHERE id = ?')
      .run(new Date().toISOString(), followerId);
  }
};

module.exports = Follow;
