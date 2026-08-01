const db = require('../config/db');
const { isStaff } = require('../config/roles');
const { v4: uuidv4 } = require('uuid');

/** The two branches of the tree. They share a thread, a status and a read-marker; little else. */
const TYPES = ['bug', 'suggestion'];

/**
 * What a piece of feedback is about, per type. A bug's list starts at the machine and works outwards; a
 * suggestion's is about the game, so neither list would serve the other — 'crash' is not a thing to
 * suggest, and 'interface' is not a thing to crash.
 */
const CATEGORIES = {
  bug: ['crash', 'ai', 'editor', 'community', 'visuals', 'other'],
  suggestion: ['gameplay', 'writing', 'editor', 'community', 'interface', 'other']
};

/**
 * Where a thread sits, per type. A bug is triaged towards a fix; a suggestion is weighed and then
 * committed to or turned down, so 'confirmed' and 'planned' are different promises.
 */
const STATUSES = {
  bug: ['open', 'need_info', 'confirmed', 'resolved', 'wontfix'],
  suggestion: ['open', 'considering', 'planned', 'declined', 'done']
};

/** Caps, mirrored by the client so its field limits agree with what this will accept. */
const TITLE_MAX = 120;
const BODY_MAX = 4000;
const COMMENT_MAX = 4000;
/** Diagnostics are a small fixed blob; a cap stops the field being used as free storage. */
const DIAGNOSTICS_MAX = 2000;

/**
 * The thread row, its author's name, and the two counts a list shows on it.
 *
 * Votes are joined rather than counted per row: the list is paged and sortable by them, so counting one
 * page's worth would rank ten rows against each other instead of the whole board. The reply count rides
 * along for the same reason a list needs it at all — one subquery beats a query per row.
 */
const FEEDBACK_SELECT = `
  SELECT r.*,
         u.username AS reporter_username,
         u.avatar_file AS reporter_avatar_file,
         u.account_type AS reporter_account_type,
         (SELECT COUNT(*) FROM feedback_votes v WHERE v.feedback_id = r.id) AS vote_count,
         (SELECT COUNT(*) FROM feedback_comments c WHERE c.feedback_id = r.id) AS comment_count
  FROM feedback r
  LEFT JOIN users u ON u.id = r.reporter_id
`;

/**
 * Whether a thread is one this reader is a party to, which is what makes a new comment in it *news*
 * rather than something they happened to walk past.
 *
 * The two branches answer it differently. A bug is between its reporter and the team, so admins are a
 * party to every one — that is what makes the queue badge work. A suggestion is open to everyone, where
 * the only meaningful line is whether you have written in it: filed it, or replied to it.
 *
 * @param {boolean} isAdmin - Whether the reader is an admin
 * @returns {string} A SQL predicate over `r`, reading `@userId`
 */
const participationClause = (isAdmin) => `
  (
    (r.type = 'bug' AND (${isAdmin ? '1 = 1' : '0 = 1'} OR r.reporter_id = @userId))
    OR
    (r.type = 'suggestion' AND (
      r.reporter_id = @userId
      OR EXISTS (
        SELECT 1 FROM feedback_comments mine
        WHERE mine.feedback_id = r.id AND mine.author_id = @userId
      )
    ))
  )
`;

/** Orders the list may be asked for. A whitelist: the value is interpolated into the ORDER BY. */
const SORT_FIELDS = Object.assign(Object.create(null), {
  newest: 'r.created_at DESC, r.rowid DESC',
  // Ties on votes fall back to newest, so an unvoted board still reads in a sensible order.
  votes: 'vote_count DESC, r.created_at DESC, r.rowid DESC'
});

/**
 * User-filed feedback — bug reports and suggestions — and the comment thread on each.
 */
const Feedback = {
  TYPES,
  CATEGORIES,
  STATUSES,
  SORT_FIELDS,
  TITLE_MAX,
  BODY_MAX,
  COMMENT_MAX,
  DIAGNOSTICS_MAX,

  /**
   * File a bug report or a suggestion.
   *
   * A suggestion is auto-voted by its author in the same transaction: nobody files something they don't
   * want, and a board of zeroes reads as nobody caring.
   *
   * @param {Object} data - `{ type, reporterId, title, category, body, diagnostics }`
   * @returns {Object} The stored thread
   */
  create: ({ type = 'bug', reporterId, reporterRole = null, title, category, body, diagnostics }) => {
    const id = uuidv4();
    const now = new Date().toISOString();

    db.transaction(() => {
      db.prepare(`
        INSERT INTO feedback (id, type, reporter_id, reporter_role, title, category, body, status, diagnostics, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
      `).run(id, type, reporterId, reporterRole, title, category, body, JSON.stringify(diagnostics || {}), now, now);

      if (type === 'suggestion') {
        db.prepare('INSERT INTO feedback_votes (feedback_id, user_id, created_at) VALUES (?, ?, ?)')
          .run(id, reporterId, now);
      }
    })();

    return Feedback.findById(id);
  },

  /**
   * Read one thread.
   * @param {string} id - Feedback ID
   * @returns {Object|undefined} The row, or undefined when there is no such thread
   */
  findById: (id) => db.prepare(`${FEEDBACK_SELECT} WHERE r.id = ?`).get(id),

  /**
   * A page of threads.
   *
   * `type` picks the branch; `reporterId` narrows to one person's own; `status` to one triage state;
   * `category` to one area of the app. All are optional and combine, so the same query backs the
   * reporter's list, the public board and the admin's filtered queue.
   *
   * @param {Object} [options] - `{ page, limit, type, reporterId, status, category, sort }`; `sort` is a
   *   `SORT_FIELDS` key, defaulting to newest
   * @returns {Object} `{ threads, count, total }` — `total` is the match count before paging
   */
  getAll: (options = {}) => {
    const {
      page = 1, limit = 20, type = null, reporterId = null, status = null, category = null, sort = 'newest'
    } = options;
    const offset = (page - 1) * limit;

    const where = [];
    const params = {};
    if (type) {
      where.push('r.type = @type');
      params.type = type;
    }
    if (reporterId) {
      where.push('r.reporter_id = @reporterId');
      params.reporterId = reporterId;
    }
    if (status) {
      where.push('r.status = @status');
      params.status = status;
    }
    if (category) {
      where.push('r.category = @category');
      params.category = category;
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // `created_at` is an ISO string written per row, but two threads filed in the same millisecond tie.
    // `rowid` breaks it by real insertion order — the primary key is a random UUID, so ordering on that
    // would shuffle same-instant rows and a thread could repeat or vanish between pages.
    // Only a known key reaches the SQL; `sort` is a request parameter, and these are interpolated.
    const order = SORT_FIELDS[sort] || SORT_FIELDS.newest;

    const threads = db.prepare(`
      ${FEEDBACK_SELECT}
      ${filter}
      ORDER BY ${order}
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });

    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM feedback r ${filter}`).get(params);

    return { threads, count: threads.length, total: countRow ? countRow.count : 0 };
  },


  /**
   * Rewrite a report.
   *
   * Every field is optional; only what is passed is written. A type move is the one change that pulls
   * others with it, so it is handled in one statement rather than as a sequence somebody could interrupt:
   * the category must come from the new type's list, the status returns to `open` — the only value both
   * branches share — and a bug's diagnostics are deleted rather than hidden, since a suggestion is a
   * public board post and the version/platform line was collected under bug rules.
   *
   * @param {string} id - Feedback ID
   * @param {Object} fields - `{ title, body, category, type }`, any subset
   * @returns {Object|undefined} The updated thread
   */
  update: (id, { title, body, category, type } = {}) => {
    const sets = [];
    const params = [];

    if (title !== undefined) { sets.push('title = ?'); params.push(title); }
    if (body !== undefined) { sets.push('body = ?'); params.push(body); }
    if (category !== undefined) { sets.push('category = ?'); params.push(category); }
    if (type !== undefined) {
      sets.push('type = ?', "status = 'open'", "diagnostics = '{}'");
      params.push(type);
    }

    if (sets.length === 0) return Feedback.findById(id);

    const now = new Date().toISOString();
    db.prepare(`UPDATE feedback SET ${sets.join(', ')}, edited_at = ?, updated_at = ? WHERE id = ?`)
      .run(...params, now, now, id);

    return Feedback.findById(id);
  },

  /**
   * Move a thread through triage.
   * @param {string} id - Feedback ID
   * @param {string} status - One of `STATUSES` for that thread's type
   * @returns {Object|undefined} The updated thread
   */
  setStatus: (id, status) => {
    db.prepare('UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);

    return Feedback.findById(id);
  },

  /**
   * Close a thread to further replies, or reopen it. Orthogonal to status: a thread can be locked at any
   * point in triage, and reaching `done` locks nothing by itself.
   *
   * @param {string} id - Feedback ID
   * @param {boolean} locked - Whether it should be locked
   * @returns {Object|undefined} The updated thread
   */
  setLocked: (id, locked) => {
    db.prepare('UPDATE feedback SET locked_at = ? WHERE id = ?')
      .run(locked ? new Date().toISOString() : null, id);

    return Feedback.findById(id);
  },

  /**
   * Delete a thread. Its comments, votes and read-state go with it (ON DELETE CASCADE).
   * @param {string} id - Feedback ID
   */
  delete: (id) => {
    db.prepare('DELETE FROM feedback WHERE id = ?').run(id);
  },

  /**
   * Whether this user may read a thread. Any signed-in account: the queue is public so somebody can
   * check whether what they hit is already known — or already suggested — before filing it again.
   *
   * @param {Object} thread - The thread row
   * @param {Object} user - `{ id, account_type }`
   * @returns {boolean} True when the user may read it
   */
  canRead: (thread, user) => Boolean(thread && user),

  /**
   * Whether this user may write in a thread.
   *
   * A bug stays between the person who hit it and the people fixing it. A suggestion is a discussion, so
   * anyone signed in may join — until an admin locks it, which stops everyone but them.
   *
   * @param {Object} thread - The thread row
   * @param {Object} user - `{ id, account_type }`
   * @returns {boolean} True when the user may comment
   */
  canWrite: (thread, user) => {
    if (!thread || !user) return false;
    // Locking is a moderation tool, so it never locks out the moderators.
    if (isStaff(user)) return true;
    if (thread.locked_at) return false;

    return thread.type === 'suggestion' || thread.reporter_id === user.id;
  },

  /**
   * The comments on a thread, oldest first.
   * @param {string} feedbackId - Feedback ID
   * @returns {Array<Object>} Comments with their author's name and account type
   */
  comments: (feedbackId) => db.prepare(`
    SELECT c.*, u.username AS author_username, u.account_type AS author_account_type,
             u.avatar_file AS author_avatar_file
    FROM feedback_comments c
    LEFT JOIN users u ON u.id = c.author_id
    WHERE c.feedback_id = ?
    ORDER BY c.created_at ASC, c.rowid ASC
  `).all(feedbackId),

  /**
   * Add a comment, and touch the thread so an admin's queue sorts by real activity.
   *
   * @param {Object} data - `{ feedbackId, authorId, body }`
   * @returns {Object} The stored comment
   */
  addComment: ({ feedbackId, authorId, body, authorRole = null }) => {
    const id = uuidv4();
    const now = new Date().toISOString();

    // `authorRole` is a snapshot, not a join: a reply signed by the team has to keep saying so after the
    // person who wrote it stops being staff, and must not start saying so when somebody is promoted.
    db.prepare(`
      INSERT INTO feedback_comments (id, feedback_id, author_id, body, created_at, author_role)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, feedbackId, authorId, body, now, authorRole);
    db.prepare('UPDATE feedback SET updated_at = ? WHERE id = ?').run(now, feedbackId);

    return db.prepare(`
      SELECT c.*, u.username AS author_username, u.account_type AS author_account_type,
             u.avatar_file AS author_avatar_file
      FROM feedback_comments c
      LEFT JOIN users u ON u.id = c.author_id
      WHERE c.id = ?
    `).get(id);
  },

  /**
   * Read one comment, without its author's name — enough to check who wrote it.
   * @param {string} id - Comment ID
   * @returns {Object|undefined} The comment row, or undefined when there is no such row
   */
  findComment: (id) => db.prepare('SELECT * FROM feedback_comments WHERE id = ?').get(id),

  /**
   * Rewrite a comment, stamping `edited_at` so the thread can say so.
   *
   * @param {string} id - Comment ID
   * @param {string} body - The new text
   * @returns {Object} The updated comment, with its author's name
   */
  updateComment: (id, body) => {
    db.prepare('UPDATE feedback_comments SET body = ?, edited_at = ? WHERE id = ?')
      .run(body, new Date().toISOString(), id);

    return db.prepare(`
      SELECT c.*, u.username AS author_username, u.account_type AS author_account_type,
             u.avatar_file AS author_avatar_file
      FROM feedback_comments c
      LEFT JOIN users u ON u.id = c.author_id
      WHERE c.id = ?
    `).get(id);
  },

  /**
   * Remove a comment outright. The thread's own `updated_at` is left alone: it records when the thread
   * last had something to read, and taking words away is not new activity to sort a queue by.
   *
   * @param {string} id - Comment ID
   */
  deleteComment: (id) => {
    db.prepare('DELETE FROM feedback_comments WHERE id = ?').run(id);
  },

  /**
   * Whether this user has written in a thread — filed it, or replied to it. What decides whether a new
   * comment is theirs to be told about, and so whether reading records a marker at all.
   *
   * @param {Object} thread - The thread row
   * @param {string} userId - User ID
   * @returns {boolean} True when they are a party to it
   */
  hasParticipated: (thread, userId) => {
    if (!thread || !userId) return false;
    if (thread.reporter_id === userId) return true;

    const row = db.prepare('SELECT 1 AS found FROM feedback_comments WHERE feedback_id = ? AND author_id = ? LIMIT 1')
      .get(thread.id, userId);

    return Boolean(row);
  },

  /**
   * Record that this user has read the thread as it stands.
   * @param {string} feedbackId - Feedback ID
   * @param {string} userId - User ID
   */
  markSeen: (feedbackId, userId) => {
    db.prepare(`
      INSERT INTO feedback_reads (feedback_id, user_id, last_seen_at)
      VALUES (?, ?, ?)
      ON CONFLICT(feedback_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(feedbackId, userId, new Date().toISOString());
  },

  /**
   * How many of this user's threads hold a comment they have not seen.
   *
   * Only somebody else's comments count — your own reply is not news to you — and a thread never read
   * counts as soon as anyone else has written in it. Which threads count as theirs differs by type; see
   * `participationClause`.
   *
   * Compared as raw ISO strings rather than through `datetime()`, which truncates to whole seconds: a
   * reply landing in the same second as the read would otherwise never raise the badge.
   *
   * @param {Object} user - `{ id, account_type }`
   * @returns {number} Threads with something new in them
   */
  unreadCount: (user) => {
    const row = db.prepare(`
      SELECT COUNT(DISTINCT c.feedback_id) AS count
      FROM feedback_comments c
      JOIN feedback r ON r.id = c.feedback_id
      LEFT JOIN feedback_reads s ON s.feedback_id = c.feedback_id AND s.user_id = @userId
      WHERE (c.author_id IS NULL OR c.author_id <> @userId)
        AND ${participationClause(isStaff(user))}
        AND (s.last_seen_at IS NULL OR c.created_at > s.last_seen_at)
    `).get({ userId: user.id });

    return row ? row.count : 0;
  },

  /**
   * Which of the given threads hold a comment this user has not seen, so a list can flag them without a
   * query per row. Scoped exactly as `unreadCount` — a thread somebody is merely reading is never
   * unread to them, since reading it records no marker they could ever clear.
   *
   * @param {Array<string>} ids - Feedback IDs
   * @param {Object} user - `{ id, account_type }`
   * @returns {Set<string>} The IDs with something new in them
   */
  unreadAmong: (ids, user) => {
    if (!ids || ids.length === 0) return new Set();

    const placeholders = ids.map((_, index) => `@id${index}`).join(', ');
    const idParams = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));

    const rows = db.prepare(`
      SELECT DISTINCT c.feedback_id
      FROM feedback_comments c
      JOIN feedback r ON r.id = c.feedback_id
      LEFT JOIN feedback_reads s ON s.feedback_id = c.feedback_id AND s.user_id = @userId
      WHERE c.feedback_id IN (${placeholders})
        AND (c.author_id IS NULL OR c.author_id <> @userId)
        AND ${participationClause(isStaff(user))}
        AND (s.last_seen_at IS NULL OR c.created_at > s.last_seen_at)
    `).all({ userId: user.id, ...idParams });

    return new Set(rows.map((row) => row.feedback_id));
  },

  /**
   * Add or remove this user's vote. Idempotent in both directions.
   *
   * @param {string} feedbackId - Feedback ID
   * @param {string} userId - User ID
   * @param {boolean} voted - Whether they want their vote on it
   */
  setVote: (feedbackId, userId, voted) => {
    if (voted) {
      db.prepare(`
        INSERT INTO feedback_votes (feedback_id, user_id, created_at) VALUES (?, ?, ?)
        ON CONFLICT(feedback_id, user_id) DO NOTHING
      `).run(feedbackId, userId, new Date().toISOString());
      return;
    }

    db.prepare('DELETE FROM feedback_votes WHERE feedback_id = ? AND user_id = ?').run(feedbackId, userId);
  },

  /**
   * Whether this user has voted for a thread.
   * @param {string} feedbackId - Feedback ID
   * @param {string} userId - User ID
   * @returns {boolean} True when their vote is on it
   */
  hasVoted: (feedbackId, userId) => Boolean(
    db.prepare('SELECT 1 AS found FROM feedback_votes WHERE feedback_id = ? AND user_id = ?')
      .get(feedbackId, userId)
  ),

  /**
   * Which of the given threads this user has voted for, so a list can fill its buttons in without a
   * query per row.
   *
   * @param {Array<string>} ids - Feedback IDs
   * @param {string} userId - User ID
   * @returns {Set<string>} The IDs they have voted for
   */
  votedAmong: (ids, userId) => {
    if (!ids || ids.length === 0) return new Set();

    const placeholders = ids.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT feedback_id FROM feedback_votes
      WHERE user_id = ? AND feedback_id IN (${placeholders})
    `).all(userId, ...ids);

    return new Set(rows.map((row) => row.feedback_id));
  }
};

module.exports = Feedback;
