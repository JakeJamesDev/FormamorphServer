const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

/** What area of the app a report is about. Matched to the client's dropdown. */
const CATEGORIES = ['crash', 'ai', 'editor', 'community', 'visuals', 'other'];

/** Where a report sits in triage. `open` is where every report starts. */
const STATUSES = ['open', 'need_info', 'confirmed', 'resolved', 'wontfix'];

/** Statuses that mean nobody is waiting on anything — used to split an admin's queue. */
const CLOSED_STATUSES = ['resolved', 'wontfix'];

/** Caps, mirrored by the client so its field limits agree with what this will accept. */
const TITLE_MAX = 120;
const BODY_MAX = 4000;
const COMMENT_MAX = 4000;
/** Diagnostics are a small fixed blob; a cap stops the field being used as free storage. */
const DIAGNOSTICS_MAX = 2000;

/** The report row plus its reporter's name, which every surface shows alongside it. */
const REPORT_SELECT = `
  SELECT r.*, u.username AS reporter_username
  FROM bug_reports r
  LEFT JOIN users u ON u.id = r.reporter_id
`;

/**
 * User-filed bug reports and the comment thread on each.
 */
const BugReport = {
  CATEGORIES,
  STATUSES,
  CLOSED_STATUSES,
  TITLE_MAX,
  BODY_MAX,
  COMMENT_MAX,
  DIAGNOSTICS_MAX,

  /**
   * File a report.
   *
   * @param {Object} data - `{ reporterId, title, category, body, diagnostics }`
   * @returns {Object} The stored report
   */
  create: ({ reporterId, title, category, body, diagnostics }) => {
    const id = uuidv4();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO bug_reports (id, reporter_id, title, category, body, status, diagnostics, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)
    `).run(id, reporterId, title, category, body, JSON.stringify(diagnostics || {}), now, now);

    return BugReport.findById(id);
  },

  /**
   * Read one report.
   * @param {string} id - Report ID
   * @returns {Object|undefined} The report, or undefined when there is no such row
   */
  findById: (id) => db.prepare(`${REPORT_SELECT} WHERE r.id = ?`).get(id),

  /**
   * A page of reports, newest first.
   *
   * `reporterId` narrows to one person's own reports; `status` to one triage state. Both are optional and
   * combine, so the same query backs the reporter's list and the admin's filtered queue.
   *
   * @param {Object} [options] - `{ page, limit, reporterId, status }`
   * @returns {Object} `{ reports, count, total }` — `total` is the match count before paging
   */
  getAll: (options = {}) => {
    const { page = 1, limit = 20, reporterId = null, status = null } = options;
    const offset = (page - 1) * limit;

    const where = [];
    const params = {};
    if (reporterId) {
      where.push('r.reporter_id = @reporterId');
      params.reporterId = reporterId;
    }
    if (status) {
      where.push('r.status = @status');
      params.status = status;
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // `created_at` is an ISO string written per row, but two reports filed in the same millisecond tie.
    // `rowid` breaks it by real insertion order — the primary key is a random UUID, so ordering on that
    // would shuffle same-instant rows and a report could repeat or vanish between pages.
    const reports = db.prepare(`
      ${REPORT_SELECT}
      ${filter}
      ORDER BY r.created_at DESC, r.rowid DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });

    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM bug_reports r ${filter}`).get(params);

    return { reports, count: reports.length, total: countRow ? countRow.count : 0 };
  },

  /**
   * Move a report through triage.
   * @param {string} id - Report ID
   * @param {string} status - One of `STATUSES`
   * @returns {Object|undefined} The updated report
   */
  setStatus: (id, status) => {
    db.prepare('UPDATE bug_reports SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, new Date().toISOString(), id);

    return BugReport.findById(id);
  },

  /**
   * Delete a report. Its comments and read-state go with it (ON DELETE CASCADE).
   * @param {string} id - Report ID
   */
  delete: (id) => {
    db.prepare('DELETE FROM bug_reports WHERE id = ?').run(id);
  },

  /**
   * Whether this user may read a report and its thread. Any signed-in account: the queue is public so
   * somebody can check whether what they hit is already known before filing it again.
   *
   * @param {Object} report - The report row
   * @param {Object} user - `{ id, account_type }`
   * @returns {boolean} True when the user may read it
   */
  canRead: (report, user) => Boolean(report && user),

  /**
   * Whether this user may write in a thread. The reporter and any admin, nobody else — reading a bug is
   * open to everyone, but the conversation stays between the person who hit it and the people fixing it.
   *
   * @param {Object} report - The report row
   * @param {Object} user - `{ id, account_type }`
   * @returns {boolean} True when the user may comment
   */
  canWrite: (report, user) =>
    Boolean(report && user && (report.reporter_id === user.id || user.account_type === 'admin')),

  /**
   * The thread on a report, oldest first.
   * @param {string} reportId - Report ID
   * @returns {Array<Object>} Comments with their author's name and account type
   */
  comments: (reportId) => db.prepare(`
    SELECT c.*, u.username AS author_username, u.account_type AS author_account_type
    FROM bug_comments c
    LEFT JOIN users u ON u.id = c.author_id
    WHERE c.report_id = ?
    ORDER BY c.created_at ASC, c.rowid ASC
  `).all(reportId),

  /**
   * Add a comment, and touch the report so an admin's queue sorts by real activity.
   *
   * @param {Object} data - `{ reportId, authorId, body }`
   * @returns {Object} The stored comment
   */
  addComment: ({ reportId, authorId, body }) => {
    const id = uuidv4();
    const now = new Date().toISOString();

    db.prepare('INSERT INTO bug_comments (id, report_id, author_id, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, reportId, authorId, body, now);
    db.prepare('UPDATE bug_reports SET updated_at = ? WHERE id = ?').run(now, reportId);

    return db.prepare(`
      SELECT c.*, u.username AS author_username, u.account_type AS author_account_type
      FROM bug_comments c
      LEFT JOIN users u ON u.id = c.author_id
      WHERE c.id = ?
    `).get(id);
  },

  /**
   * Read one comment, without its author's name — enough to check who wrote it.
   * @param {string} id - Comment ID
   * @returns {Object|undefined} The comment row, or undefined when there is no such row
   */
  findComment: (id) => db.prepare('SELECT * FROM bug_comments WHERE id = ?').get(id),

  /**
   * Rewrite a comment, stamping `edited_at` so the thread can say so.
   *
   * @param {string} id - Comment ID
   * @param {string} body - The new text
   * @returns {Object} The updated comment, with its author's name
   */
  updateComment: (id, body) => {
    db.prepare('UPDATE bug_comments SET body = ?, edited_at = ? WHERE id = ?')
      .run(body, new Date().toISOString(), id);

    return db.prepare(`
      SELECT c.*, u.username AS author_username, u.account_type AS author_account_type
      FROM bug_comments c
      LEFT JOIN users u ON u.id = c.author_id
      WHERE c.id = ?
    `).get(id);
  },

  /**
   * Remove a comment outright. The report's own `updated_at` is left alone: it records when the thread
   * last had something to read, and taking words away is not new activity to sort a queue by.
   *
   * @param {string} id - Comment ID
   */
  deleteComment: (id) => {
    db.prepare('DELETE FROM bug_comments WHERE id = ?').run(id);
  },

  /**
   * Record that this user has read the thread as it stands.
   * @param {string} reportId - Report ID
   * @param {string} userId - User ID
   */
  markSeen: (reportId, userId) => {
    db.prepare(`
      INSERT INTO bug_report_reads (report_id, user_id, last_seen_at)
      VALUES (?, ?, ?)
      ON CONFLICT(report_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(reportId, userId, new Date().toISOString());
  },

  /**
   * How many of this user's threads hold a comment they have not seen.
   *
   * Only somebody else's comments count — your own reply is not news to you — and a thread never read
   * counts as soon as anyone else has written in it. Admins are counted against every open report;
   * a reporter only against their own.
   *
   * Compared as raw ISO strings rather than through `datetime()`, which truncates to whole seconds: a
   * reply landing in the same second as the read would otherwise never raise the badge.
   *
   * @param {Object} user - `{ id, account_type }`
   * @returns {number} Threads with something new in them
   */
  unreadCount: (user) => {
    const scope = user.account_type === 'admin' ? '' : 'AND r.reporter_id = @userId';

    const row = db.prepare(`
      SELECT COUNT(DISTINCT c.report_id) AS count
      FROM bug_comments c
      JOIN bug_reports r ON r.id = c.report_id
      LEFT JOIN bug_report_reads s ON s.report_id = c.report_id AND s.user_id = @userId
      WHERE c.author_id <> @userId
        ${scope}
        AND (s.last_seen_at IS NULL OR c.created_at > s.last_seen_at)
    `).get({ userId: user.id });

    return row ? row.count : 0;
  },

  /**
   * Which of the given reports hold a comment this user has not seen, so a list can flag them without a
   * query per row.
   *
   * @param {Array<string>} reportIds - Report IDs
   * @param {string} userId - User ID
   * @returns {Set<string>} The IDs with something new in them
   */
  unreadAmong: (reportIds, userId) => {
    if (!reportIds || reportIds.length === 0) return new Set();

    const placeholders = reportIds.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT DISTINCT c.report_id
      FROM bug_comments c
      LEFT JOIN bug_report_reads s ON s.report_id = c.report_id AND s.user_id = ?
      WHERE c.report_id IN (${placeholders})
        AND c.author_id <> ?
        AND (s.last_seen_at IS NULL OR c.created_at > s.last_seen_at)
    `).all(userId, ...reportIds, userId);

    return new Set(rows.map((row) => row.report_id));
  }
};

module.exports = BugReport;
