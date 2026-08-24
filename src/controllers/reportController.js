const Report = require('../models/Report');
const World = require('../models/World');
const Comment = require('../models/Comment');
const User = require('../models/User');
const Message = require('../models/Message');
const AuditLog = require('../models/AuditLog');
const { canModerate, STAFF_PROTECTED } = require('../config/roles');
const { resolutionNotice } = require('../utils/reportNotices');

/** What a duplicate is told. One wording, because the reporter's question is "did it land?" */
const ALREADY_REPORTED = 'You have already reported this — staff are reviewing it.';

/**
 * The target of a report, read as it stands right now.
 *
 * Resolves the three kinds to one shape: what to snapshot, and whose account the moderation gate is
 * about. A target that cannot be found is not reportable — but a target that is merely *quarantined*
 * still is, because a report filed while something was hidden is still the room telling staff something.
 *
 * @param {string} kind - One of `Report.TARGET_KINDS`
 * @param {string} id - The target's ID
 * @returns {Object|null} `{ authorId, snapshot }`, or null when there is no such target
 */
const resolveTarget = (kind, id) => {
  if (kind === 'listing') {
    const world = World.findById(id);
    if (!world) return null;

    const author = world.author_id ? User.findById(world.author_id) : null;

    return {
      authorId: world.author_id || null,
      snapshot: {
        name: world.name,
        authorId: world.author_id || null,
        authorUsername: author ? author.username : null,
        // A listing's own words are what was published; the description is the reportable part of it.
        snippet: world.description
      }
    };
  }

  if (kind === 'comment') {
    const comment = Comment.findById(id);
    if (!comment) return null;

    const author = comment.author_id ? User.findById(comment.author_id) : null;
    const world = comment.world_id ? World.findById(comment.world_id) : null;

    return {
      authorId: comment.author_id || null,
      snapshot: {
        // Named by where it sits: a comment has no title, and "a comment on Sedge Landing" is what a
        // moderator needs to find it again.
        name: world ? world.name : null,
        authorId: comment.author_id || null,
        authorUsername: author ? author.username : null,
        // The offending text itself, which is the whole case — and the only copy left once it is deleted.
        snippet: comment.content,
        // Where to go to see it in context. Without this the queue holds a comment id and no way to reach it.
        parentId: comment.world_id || null
      }
    };
  }

  if (kind === 'profile') {
    const user = User.findById(id);
    if (!user) return null;

    return {
      authorId: user.id,
      snapshot: {
        name: user.username,
        authorId: user.id,
        authorUsername: user.username,
        snippet: null
      }
    };
  }

  return null;
};

/**
 * @desc    The categories and caps this server will accept, so the client's form agrees with it — and,
 *          by answering at all, the flag a client uses to know reports exist here
 * @route   GET /api/reports/meta
 * @access  Private
 */
exports.getMeta = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      data: {
        categories: Report.CATEGORIES,
        targetKinds: Report.TARGET_KINDS,
        outcomes: Report.OUTCOMES,
        detailsMax: Report.DETAILS_MAX,
        noteMax: Report.NOTE_MAX
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    File a report
 * @route   POST /api/reports
 * @access  Private (any signed-in account)
 */
exports.submitReport = async (req, res, next) => {
  try {
    const targetKind = String(req.body.targetKind || '');
    const targetId = String(req.body.targetId || '');
    const category = String(req.body.category || '');
    const details = typeof req.body.details === 'string' ? req.body.details.trim() : '';

    if (!Report.TARGET_KINDS.includes(targetKind)) {
      return res.status(400).json({ success: false, error: 'Unknown report target' });
    }
    if (!Report.CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, error: 'Pick a category' });
    }
    if (details.length > Report.DETAILS_MAX) {
      return res.status(400).json({
        success: false,
        error: `Details cannot exceed ${Report.DETAILS_MAX} characters`
      });
    }

    const target = resolveTarget(targetKind, targetId);
    if (!target) {
      return res.status(404).json({ success: false, error: 'That content no longer exists' });
    }

    // Reporting your own work is not moderation, it is a way to put your own listing in the queue.
    if (target.authorId && target.authorId === req.user.id) {
      return res.status(400).json({ success: false, error: 'You cannot report your own content' });
    }

    if (Report.hasOpen(req.user.id, targetKind, targetId)) {
      return res.status(409).json({ success: false, error: ALREADY_REPORTED });
    }

    const report = Report.create({
      reporterId: req.user.id,
      targetKind,
      targetId,
      category,
      details: details || null,
      snapshot: target.snapshot
    });

    // Answered with the shape a reporter is allowed to know about their own report, and nothing about
    // anyone else's: how many others filed one is staff's business.
    res.status(201).json({
      success: true,
      data: { id: report.id, status: report.status, category: report.category, createdAt: report.created_at }
    });
  } catch (error) {
    // The unique partial index is the same rule as `hasOpen`, reached when two requests race it. The
    // caller asked a question the guard already answers, so it gets that answer rather than a 500.
    if (error && String(error.code || '').startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ success: false, error: ALREADY_REPORTED });
    }

    next(error);
  }
};

/**
 * @desc    The open queue, grouped by reported target
 * @route   GET /api/reports
 * @access  Private (staff)
 */
exports.getQueue = async (req, res, next) => {
  try {
    // Clamped at both ends. SQLite reads a negative LIMIT as no limit at all, so a bare `Math.min`
    // would let `?limit=-1` ask for every open group — and each one costs a further query.
    const asked = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 200) : 100;

    const groups = Report.openGroups({ limit });

    // Every group is visible to every staff member, staff-authored targets included — a complaint about
    // the team that only the team it is about can see is not a complaint anyone will read. Who may *close*
    // one is decided at resolution, where the rule belongs.
    res.status(200).json({ success: true, count: groups.length, data: groups });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    How many targets have an open report on them, for the staff badge
 * @route   GET /api/reports/open-count
 * @access  Private (staff)
 */
exports.getOpenCount = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, open: Report.openGroupCount() });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Resolve every open report on one target, and tell each reporter
 * @route   POST /api/reports/resolve
 * @access  Private (staff who may moderate the target's author)
 */
exports.resolveTargetReports = async (req, res, next) => {
  try {
    const targetKind = String(req.body.targetKind || '');
    const targetId = String(req.body.targetId || '');
    const outcome = String(req.body.outcome || '');
    const note = typeof req.body.note === 'string' ? req.body.note.trim() : '';

    if (!Report.TARGET_KINDS.includes(targetKind)) {
      return res.status(400).json({ success: false, error: 'Unknown report target' });
    }
    if (!Report.OUTCOMES.includes(outcome)) {
      return res.status(400).json({ success: false, error: 'Pick an outcome' });
    }
    if (note.length > Report.NOTE_MAX) {
      return res.status(400).json({
        success: false,
        error: `A note cannot exceed ${Report.NOTE_MAX} characters`
      });
    }

    const open = Report.openOn(targetKind, targetId);
    if (open.length === 0) {
      return res.status(404).json({ success: false, error: 'No open reports on that' });
    }

    // The author as they are now, not as the snapshot remembers them: a promotion between the filing and
    // the resolution changes who may close it, and the live row is the only thing that knows.
    const authorId = open[open.length - 1].target_author_id;
    const author = authorId ? User.findById(authorId) : null;

    // Staff moderate the room, not each other — the same rule as every other moderation act, applied to
    // the author of what was reported. An author who has since been deleted leaves nobody to protect.
    if (author && !canModerate(req.user, author)) {
      return res.status(403).json({ success: false, error: STAFF_PROTECTED });
    }

    const resolved = Report.resolveGroup({
      targetKind,
      targetId,
      outcome,
      resolvedBy: req.user.id,
      note: note || null
    });

    // One message each rather than one shared row, so a reporter's notice is theirs — receipted,
    // dismissible and recallable on its own, exactly as a direct message from an admin is.
    let notified = 0;
    for (const report of resolved) {
      if (!report.reporter_id) continue;

      try {
        Message.create({
          ...resolutionNotice(report, outcome, note || null),
          senderId: req.user.id,
          recipientId: report.reporter_id
        });
        notified += 1;
      } catch (error) {
        // The resolution has already happened. A notice that fails to send must not turn a closed group
        // back into an open one, so it fails loudly to the console and the rest still go out.
        console.error('Failed to notify a reporter of a resolution:', report.id, error);
      }
    }

    AuditLog.tryRecord({
      action: outcome === 'actioned' ? 'report_actioned' : 'report_dismissed',
      actor: req.user,
      targetUser: author,
      targetKind,
      targetName: resolved[resolved.length - 1].target_name,
      // The staff note, not the reporters' words: the entry records what staff decided and said.
      snippet: note || null
    });

    res.status(200).json({
      success: true,
      data: { resolved: resolved.length, notified, outcome }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Flag every open report on a target whose content has just been deleted by its own author.
 *
 * Called from the delete routes rather than left to a cascade, because a cascade would delete exactly
 * the tickets still owed an answer. Self-removal neither punishes nor absolves: the report stays open,
 * the snapshot says what was there, and staff still close the loop.
 *
 * Never throws — the deletion it follows has already happened.
 *
 * @param {string} targetKind - One of `Report.TARGET_KINDS`
 * @param {string} targetId - The deleted target's ID
 * @returns {number} How many reports were flagged
 */
exports.flagDeletedTarget = (targetKind, targetId) => {
  try {
    return Report.flagTargetGone(targetKind, targetId);
  } catch (error) {
    console.error('Failed to flag reports on a deleted target:', targetKind, targetId, error);
    return 0;
  }
};

/**
 * Flag every open report on a listing *and* on the comments that went down with it.
 *
 * `comments.world_id` cascades, so deleting a listing silently takes its whole thread with it. Without
 * this a report on one of those comments sits in the queue looking live — offering a moderator a "view
 * in context" onto a listing that is not there — while its reporters wait on an answer.
 *
 * The reports carry the comment ids themselves, so nothing has to be read before the delete: the ones to
 * flag are exactly the open comment reports whose recorded parent is this listing.
 *
 * Never throws — the deletion it follows has already happened.
 *
 * @param {string} worldId - The deleted listing's ID
 * @returns {number} How many reports were flagged, the listing's own included
 */
exports.flagDeletedListing = (worldId) => {
  try {
    return Report.flagTargetGone('listing', worldId) + Report.flagChildrenGone(worldId);
  } catch (error) {
    console.error('Failed to flag reports on a deleted listing:', worldId, error);
    return 0;
  }
};
