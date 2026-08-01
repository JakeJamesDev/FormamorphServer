const db = require('../config/db');

/**
 * What happened. One value per kind of event the log records, so the admin filter is a fixed list rather
 * than whatever strings happen to be in the table.
 */
const ACTIONS = [
  'user_suspended',
  'user_unsuspended',
  'terms_reset_user',
  'terms_reset_all',
  'listing_deleted',
  'comment_deleted',
  'feedback_deleted',
  'listing_quarantined',
  'quarantine_updated',
  'quarantine_released',
  'quarantine_expired'
];

/** Enough of what was removed to know what it was; never the whole of it. */
const SNIPPET_MAX = 200;

/** Columns the list may be narrowed by. A whitelist: values reach the SQL as bound parameters. */
const searchClause = `(
  a.actor_username LIKE @term ESCAPE '\\'
  OR a.target_username LIKE @term ESCAPE '\\'
  OR a.target_name LIKE @term ESCAPE '\\'
)`;

/**
 * Append-only record of what was done to accounts and to published work.
 *
 * Every name is stored as a snapshot rather than joined at read time: an entry has to still read after
 * the world, the comment or the account it describes is gone — which is the whole reason to keep one.
 *
 * There is deliberately no delete or update. An audit trail somebody can edit is not one.
 */
const AuditLog = {
  ACTIONS,
  SNIPPET_MAX,

  /**
   * Record one event.
   *
   * @param {Object} entry - `{ action, actor, targetUser, targetKind, targetName, snippet }`.
   *   `actor` and `targetUser` are user rows (or anything with `id`/`username`); both are optional, since
   *   not every event has a person on the other end of it.
   * @returns {Object} The stored entry
   */
  record: ({ action, actor = null, targetUser = null, targetKind = null, targetName = null, snippet = null }) => {
    const info = db.prepare(`
      INSERT INTO audit_log (
        action, actor_id, actor_username, actor_was_admin,
        target_user_id, target_username, target_kind, target_name, snippet, created_at
      )
      VALUES (@action, @actorId, @actorUsername, @actorWasAdmin,
              @targetUserId, @targetUsername, @targetKind, @targetName, @snippet, @createdAt)
    `).run({
      action,
      actorId: actor ? actor.id : null,
      actorUsername: actor ? actor.username : null,
      // Recorded as it was at the time: an account demoted later did not act as an ordinary user then.
      actorWasAdmin: actor && actor.account_type === 'admin' ? 1 : 0,
      targetUserId: targetUser ? targetUser.id : null,
      targetUsername: targetUser ? targetUser.username : null,
      targetKind,
      targetName: targetName === null || targetName === undefined ? null : String(targetName).slice(0, SNIPPET_MAX),
      snippet: snippet === null || snippet === undefined ? null : String(snippet).slice(0, SNIPPET_MAX),
      createdAt: new Date().toISOString()
    });

    return AuditLog.findById(info.lastInsertRowid);
  },

  /**
   * Record one event, swallowing any failure.
   *
   * What every caller uses. The action it describes has already happened by the time this runs, so a
   * failure here must not turn a completed suspension or takedown into a 500 the caller retries — a gap
   * in the trail is bad, an action that reports failure after succeeding is worse. It fails loudly to the
   * console so the gap is at least visible to whoever runs the server.
   *
   * @param {Object} entry - As `record`
   * @returns {Object|null} The stored entry, or null when it could not be written
   */
  tryRecord: (entry) => {
    try {
      return AuditLog.record(entry);
    } catch (error) {
      console.error('Failed to write an audit log entry:', entry && entry.action, error);
      return null;
    }
  },

  /**
   * Read one entry.
   * @param {number} id - Entry ID
   * @returns {Object|undefined} The row, or undefined when there is no such entry
   */
  findById: (id) => db.prepare('SELECT * FROM audit_log a WHERE a.id = ?').get(id),

  /**
   * A page of entries, newest first.
   *
   * Ordered by the autoincrement id rather than the timestamp: it is the real insertion order, so two
   * events in the same millisecond can't repeat or vanish between pages.
   *
   * @param {Object} [options] - `{ page, limit, action, search }`; `search` matches the actor, the target
   *   account or the target's name
   * @returns {Object} `{ entries, count, total }` — `total` is the match count before paging
   */
  getAll: (options = {}) => {
    const { page = 1, limit = 20, action = null, search = '' } = options;
    const offset = (page - 1) * limit;

    const where = [];
    const params = {};
    if (action) {
      where.push('a.action = @action');
      params.action = action;
    }
    if (search) {
      // Escape LIKE wildcards so a search for `%` matches a literal percent instead of every row.
      params.term = `%${String(search).replace(/[\\%_]/g, '\\$&')}%`;
      where.push(searchClause);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const entries = db.prepare(`
      SELECT * FROM audit_log a
      ${filter}
      ORDER BY a.id DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });

    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM audit_log a ${filter}`).get(params);

    return { entries, count: entries.length, total: countRow ? countRow.count : 0 };
  }
};

module.exports = AuditLog;
