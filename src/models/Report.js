const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

/**
 * What a Report says is wrong. Ordered by severity so a queue sorted on it reads worst-first, and short
 * enough that a reporter picks rather than writes — triage is the whole reason the field exists.
 */
const CATEGORIES = ['illegal', 'hate', 'spam', 'stolen', 'malicious', 'other'];

/** What can be reported. Polymorphic by design: none of the three shares a table with the others. */
const TARGET_KINDS = ['listing', 'comment', 'profile'];

/** How a group closes. Two values, because a reporter is owed the answer and never the method. */
const OUTCOMES = ['actioned', 'dismissed'];

/** The reporter's own words. Optional, and capped so the field is not free storage. */
const DETAILS_MAX = 2000;

/** What staff may add to the notice the reporters receive. Shorter than the details: it is a line, not a
 *  letter. */
const NOTE_MAX = 1000;

/** Enough of what was reported to know what it was, the audit log's cap for the same reason. */
const SNIPPET_MAX = 200;

/**
 * A Report row plus the name behind its reporter id.
 *
 * The username is joined rather than snapshotted — the opposite of the target fields below. A reporter is
 * a live account staff may need to reach; a target is a thing that has to still read after it is gone.
 */
const REPORT_SELECT = `
  SELECT r.*, u.username AS reporter_username, u.account_type AS reporter_account_type
  FROM reports r
  LEFT JOIN users u ON u.id = r.reporter_id
`;

/**
 * User-filed reports on community content, and the queue staff work them from.
 *
 * A Report is one-shot: filed once, resolved once, never replied to. Everything about the target is
 * snapshotted at filing time, following the audit log's pattern, so a ticket outlives what it is about —
 * which is the case that matters most, since deleting the thing is one of the ways a report ends.
 */
const Report = {
  CATEGORIES,
  TARGET_KINDS,
  OUTCOMES,
  DETAILS_MAX,
  NOTE_MAX,
  SNIPPET_MAX,

  /**
   * File a report.
   *
   * @param {Object} data - `{ reporterId, targetKind, targetId, category, details, snapshot }`, where
   *   `snapshot` is `{ name, authorId, authorUsername, snippet, parentId }` as the target read at
   *   filing time
   * @returns {Object} The stored report
   */
  create: ({ reporterId, targetKind, targetId, category, details = null, snapshot = {} }) => {
    const id = uuidv4();
    const clip = (value) => (value === null || value === undefined ? null : String(value).slice(0, SNIPPET_MAX));

    db.prepare(`
      INSERT INTO reports (
        id, reporter_id, target_kind, target_id,
        target_name, target_author_id, target_author_username, target_snippet, target_parent_id,
        category, details, status, created_at
      )
      VALUES (@id, @reporterId, @targetKind, @targetId,
              @targetName, @targetAuthorId, @targetAuthorUsername, @targetSnippet, @targetParentId,
              @category, @details, 'open', @createdAt)
    `).run({
      id,
      reporterId,
      targetKind,
      targetId,
      targetName: clip(snapshot.name),
      targetAuthorId: snapshot.authorId || null,
      targetAuthorUsername: clip(snapshot.authorUsername),
      targetSnippet: clip(snapshot.snippet),
      targetParentId: snapshot.parentId || null,
      category,
      details: details ? String(details).slice(0, DETAILS_MAX) : null,
      createdAt: new Date().toISOString()
    });

    return Report.findById(id);
  },

  /**
   * Read one report.
   * @param {string} id - Report ID
   * @returns {Object|undefined} The row, or undefined when there is no such report
   */
  findById: (id) => db.prepare(`${REPORT_SELECT} WHERE r.id = ?`).get(id),

  /**
   * Whether this reporter already has an open report on this target.
   *
   * The flood control that matters, and the one thing a reporter is told about their own history: filing
   * again while the first is open says nothing new, and telling them it is pending is the difference
   * between a queue and a void. A unique partial index enforces the same rule underneath, so a race
   * between two requests cannot slip a second one past this.
   *
   * @param {string} reporterId - Reporter's user ID
   * @param {string} targetKind - One of `TARGET_KINDS`
   * @param {string} targetId - The target's ID
   * @returns {boolean} True when one is already open
   */
  hasOpen: (reporterId, targetKind, targetId) => Boolean(
    db.prepare(`
      SELECT 1 AS found FROM reports
      WHERE reporter_id = ? AND target_kind = ? AND target_id = ? AND status = 'open'
      LIMIT 1
    `).get(reporterId, targetKind, targetId)
  ),

  /**
   * Every open report on one target, oldest first.
   *
   * What resolution fans out over, and what the queue shows under a group's heading.
   *
   * @param {string} targetKind - One of `TARGET_KINDS`
   * @param {string} targetId - The target's ID
   * @returns {Array<Object>} The open reports
   */
  openOn: (targetKind, targetId) => db.prepare(`
    ${REPORT_SELECT}
    WHERE r.target_kind = ? AND r.target_id = ? AND r.status = 'open'
    ORDER BY r.created_at ASC, r.rowid ASC
  `).all(targetKind, targetId),

  /**
   * The queue: one entry per reported target, with every open report on it.
   *
   * Grouped here rather than by the reader, because a pile-on is one piece of work and a list of twelve
   * identical rows is twelve times the triage for one decision. The group's fields come from the newest
   * report in it — the snapshots agree in every ordinary case, and when they do not, the latest look at
   * the target is the useful one.
   *
   * @param {Object} [options] - `{ limit }`
   * @returns {Array<Object>} Groups, most-recently-reported first
   */
  openGroups: (options = {}) => {
    const { limit = 100 } = options;

    const groups = db.prepare(`
      SELECT target_kind, target_id,
             COUNT(*) AS report_count,
             MIN(created_at) AS first_reported_at,
             MAX(created_at) AS last_reported_at,
             MAX(CASE WHEN target_gone_at IS NOT NULL THEN 1 ELSE 0 END) AS target_gone
      FROM reports
      WHERE status = 'open'
      GROUP BY target_kind, target_id
      ORDER BY last_reported_at DESC
      LIMIT @limit
    `).all({ limit });

    // The author's role, unlike everything else about the target, is read live. Who may close a group is
    // decided by what that account is *now*, so a snapshot would leave the queue offering a button the
    // resolution route then refuses.
    const roleOfAuthor = db.prepare('SELECT account_type FROM users WHERE id = ?');

    return groups.map((group) => {
      const reports = Report.openOn(group.target_kind, group.target_id);
      const latest = reports[reports.length - 1] || {};
      const authorId = latest.target_author_id || null;
      const authorRow = authorId ? roleOfAuthor.get(authorId) : null;

      return {
        ...group,
        target_gone: Boolean(group.target_gone),
        target_name: latest.target_name || null,
        target_author_id: authorId,
        target_author_username: latest.target_author_username || null,
        target_author_role: authorRow ? authorRow.account_type : null,
        target_snippet: latest.target_snippet || null,
        target_parent_id: latest.target_parent_id || null,
        reports
      };
    });
  },

  /**
   * How many targets have an open report on them.
   *
   * Targets rather than reports, so the badge counts the same units the queue shows: one piece of work,
   * however many people filed it.
   *
   * @returns {number} The count
   */
  openGroupCount: () => {
    const row = db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM reports WHERE status = 'open' GROUP BY target_kind, target_id
      )
    `).get();

    return row ? row.count : 0;
  },

  /**
   * Close every open report on a target, in one transaction.
   *
   * Per-target rather than per-report because the decision is: staff judged the content once, so every
   * report of it gets that answer. The rows come back so the caller can notify each reporter — the model
   * stores, the controller speaks.
   *
   * @param {Object} data - `{ targetKind, targetId, outcome, resolvedBy, note }`
   * @returns {Array<Object>} The reports as they were before closing, oldest first
   */
  resolveGroup: ({ targetKind, targetId, outcome, resolvedBy, note = null }) => {
    const open = Report.openOn(targetKind, targetId);
    if (open.length === 0) return [];

    const now = new Date().toISOString();

    db.transaction(() => {
      db.prepare(`
        UPDATE reports
        SET status = 'resolved', outcome = @outcome, resolved_at = @now,
            resolved_by = @resolvedBy, resolution_note = @note
        WHERE target_kind = @targetKind AND target_id = @targetId AND status = 'open'
      `).run({
        targetKind,
        targetId,
        outcome,
        resolvedBy: resolvedBy || null,
        note: note ? String(note).slice(0, NOTE_MAX) : null,
        now
      });
    })();

    return open;
  },

  /**
   * Mark every open report on a target as reporting something that is no longer there.
   *
   * The ticket stays open. An author deleting what was reported is neither a punishment nor a pardon —
   * staff can still act on the account, and the reporters are still owed an answer — so the only thing
   * that changes is that the queue says the content is gone and leans on the snapshot to say what it was.
   *
   * @param {string} targetKind - One of `TARGET_KINDS`
   * @param {string} targetId - The target's ID
   * @returns {number} How many reports were flagged
   */
  flagTargetGone: (targetKind, targetId) => db.prepare(`
    UPDATE reports SET target_gone_at = ?
    WHERE target_kind = ? AND target_id = ? AND status = 'open' AND target_gone_at IS NULL
  `).run(new Date().toISOString(), targetKind, targetId).changes,

  /**
   * The same, for everything that lived inside a deleted listing.
   *
   * A comment goes when its listing does — `comments.world_id` cascades — so a report on one is orphaned
   * by a delete that never names it. Matched on the recorded parent rather than by asking the comments
   * table, which is exactly what is no longer there.
   *
   * @param {string} parentId - The deleted listing's ID
   * @returns {number} How many reports were flagged
   */
  flagChildrenGone: (parentId) => db.prepare(`
    UPDATE reports SET target_gone_at = ?
    WHERE target_parent_id = ? AND status = 'open' AND target_gone_at IS NULL
  `).run(new Date().toISOString(), parentId).changes
};

module.exports = Report;
