const BugReport = require('../models/BugReport');

/** A report as any reader of it sees it. `unread` is per-reader, so the caller supplies it. */
const toReportDto = (row, unread = false) => ({
  id: row.id,
  title: row.title,
  category: row.category,
  body: row.body,
  status: row.status,
  reporter: { id: row.reporter_id, username: row.reporter_username || null },
  // Stored as JSON text; a row written by hand could be malformed, and one bad row must not fail the list.
  diagnostics: safeParse(row.diagnostics),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  unread
});

const toCommentDto = (row) => ({
  id: row.id,
  body: row.body,
  createdAt: row.created_at,
  editedAt: row.edited_at || null,
  author: {
    id: row.author_id,
    username: row.author_username || null,
    // Drives how the thread styles it — a reply from the team reads differently from the reporter's own.
    isAdmin: row.author_account_type === 'admin'
  }
});

function safeParse(text) {
  try {
    const parsed = JSON.parse(text || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Trimmed string, or '' for anything that isn't one. */
const asText = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @desc    File a bug report
 * @route   POST /api/bugs
 * @access  Private
 */
exports.createReport = async (req, res, next) => {
  try {
    const title = asText(req.body.title);
    const body = asText(req.body.body);
    const { category } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, error: 'A title is required' });
    }
    if (title.length > BugReport.TITLE_MAX) {
      return res.status(400).json({ success: false, error: `A title is limited to ${BugReport.TITLE_MAX} characters` });
    }
    if (!body) {
      return res.status(400).json({ success: false, error: 'A description is required' });
    }
    if (body.length > BugReport.BODY_MAX) {
      return res.status(400).json({ success: false, error: `A description is limited to ${BugReport.BODY_MAX} characters` });
    }
    if (!BugReport.CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, error: 'Unknown category' });
    }

    // Diagnostics are whatever the client says about itself, so they are stored as given but bounded —
    // this field is never trusted, only displayed.
    const diagnostics = req.body.diagnostics;
    const encoded = JSON.stringify(diagnostics && typeof diagnostics === 'object' && !Array.isArray(diagnostics) ? diagnostics : {});
    if (encoded.length > BugReport.DIAGNOSTICS_MAX) {
      return res.status(400).json({ success: false, error: 'Diagnostics are too large' });
    }

    const report = BugReport.create({
      reporterId: req.user.id,
      title,
      category,
      body,
      diagnostics: JSON.parse(encoded)
    });

    res.status(201).json({ success: true, data: toReportDto(report) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    List reports — the caller's own, or everyone's for an admin
 * @route   GET /api/bugs
 * @access  Private
 */
exports.getReports = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    // An unknown status is ignored rather than rejected — it falls back to every report, which is what
    // an unfiltered list already shows.
    const status = BugReport.STATUSES.includes(req.query.status) ? req.query.status : null;

    // The queue is public, so `scope=all` is open to anyone: checking whether a bug is already filed
    // beats filing it twice. Without it the list is the caller's own, which is what the profile opens on.
    const reporterId = req.query.scope === 'all' ? null : req.user.id;

    const result = BugReport.getAll({ page, limit, reporterId, status });
    const unread = BugReport.unreadAmong(result.reports.map((r) => r.id), req.user.id);

    res.status(200).json({
      success: true,
      count: result.count,
      total: result.total,
      data: result.reports.map((row) => toReportDto(row, unread.has(row.id)))
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Read one report and its thread. Reading marks the thread seen for this user.
 * @route   GET /api/bugs/:id
 * @access  Private (any signed-in account)
 */
exports.getReport = async (req, res, next) => {
  try {
    const report = BugReport.findById(req.params.id);
    if (!report) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }
    if (!BugReport.canRead(report, req.user)) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }

    const comments = BugReport.comments(report.id);
    // Only for someone the thread badges. A passing reader has no unread state to clear, and writing one
    // would leave a read-marker per report per curious account.
    if (BugReport.canWrite(report, req.user)) BugReport.markSeen(report.id, req.user.id);

    res.status(200).json({
      success: true,
      data: toReportDto(report),
      comments: comments.map(toCommentDto)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Add a comment to a report's thread
 * @route   POST /api/bugs/:id/comments
 * @access  Private (reporter or admin)
 */
exports.addComment = async (req, res, next) => {
  try {
    const report = BugReport.findById(req.params.id);
    if (!report) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }
    // Readable by anyone, writable by the two sides of it — so this is a plain refusal, not a 404.
    if (!BugReport.canWrite(report, req.user)) {
      return res.status(403).json({ success: false, error: 'Only the reporter and the team can reply here' });
    }

    const body = asText(req.body.body);
    if (!body) {
      return res.status(400).json({ success: false, error: 'A comment is required' });
    }
    if (body.length > BugReport.COMMENT_MAX) {
      return res.status(400).json({ success: false, error: `A comment is limited to ${BugReport.COMMENT_MAX} characters` });
    }

    const comment = BugReport.addComment({ reportId: report.id, authorId: req.user.id, body });
    // Writing in a thread means having read it; leaving it unread would badge the author's own reply.
    BugReport.markSeen(report.id, req.user.id);

    res.status(201).json({ success: true, data: toCommentDto(comment) });
  } catch (error) {
    next(error);
  }
};

/**
 * Locate a comment for an edit or a delete. Authorship is the only gate that matters: the thread itself
 * is readable by anyone, so a 403 on somebody else's words gives nothing away.
 *
 * @param {Object} req - The request, with `params.id` / `params.commentId` and `user`
 * @returns {Object} `{ error }` with a status and message, or `{ comment }` when it may be changed
 */
const commentForAuthor = (req) => {
  const report = BugReport.findById(req.params.id);
  if (!report) {
    return { error: { status: 404, message: 'Report not found' } };
  }

  const comment = BugReport.findComment(req.params.commentId);
  if (!comment || comment.report_id !== report.id) {
    return { error: { status: 404, message: 'Comment not found' } };
  }
  // Admins included: triage powers don't extend to rewriting what somebody else said.
  if (comment.author_id !== req.user.id) {
    return { error: { status: 403, message: 'You can only change your own comments' } };
  }

  return { comment };
};

/**
 * @desc    Rewrite one's own comment
 * @route   PUT /api/bugs/:id/comments/:commentId
 * @access  Private (the comment's author)
 */
exports.updateComment = async (req, res, next) => {
  try {
    const { error, comment } = commentForAuthor(req);
    if (error) {
      return res.status(error.status).json({ success: false, error: error.message });
    }

    const body = asText(req.body.body);
    if (!body) {
      return res.status(400).json({ success: false, error: 'A comment is required' });
    }
    if (body.length > BugReport.COMMENT_MAX) {
      return res.status(400).json({ success: false, error: `A comment is limited to ${BugReport.COMMENT_MAX} characters` });
    }

    res.status(200).json({ success: true, data: toCommentDto(BugReport.updateComment(comment.id, body)) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete one's own comment
 * @route   DELETE /api/bugs/:id/comments/:commentId
 * @access  Private (the comment's author)
 */
exports.deleteComment = async (req, res, next) => {
  try {
    const { error, comment } = commentForAuthor(req);
    if (error) {
      return res.status(error.status).json({ success: false, error: error.message });
    }

    BugReport.deleteComment(comment.id);

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Move a report through triage
 * @route   PUT /api/bugs/:id/status
 * @access  Private/Admin
 */
exports.setStatus = async (req, res, next) => {
  try {
    const report = BugReport.findById(req.params.id);
    if (!report) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }

    const { status } = req.body;
    if (!BugReport.STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: 'Unknown status' });
    }

    res.status(200).json({ success: true, data: toReportDto(BugReport.setStatus(report.id, status)) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete a report and its thread
 * @route   DELETE /api/bugs/:id
 * @access  Private/Admin
 */
exports.deleteReport = async (req, res, next) => {
  try {
    const report = BugReport.findById(req.params.id);
    if (!report) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }

    BugReport.delete(report.id);

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    How many of the caller's bug threads have something new in them
 * @route   GET /api/bugs/unread-count
 * @access  Private
 */
exports.getUnreadCount = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, unread: BugReport.unreadCount(req.user) });
  } catch (error) {
    next(error);
  }
};

/** Exposed so the client's field limits and dropdowns can be checked against the server's. */
exports.getMeta = async (_req, res) => {
  res.status(200).json({
    success: true,
    categories: BugReport.CATEGORIES,
    statuses: BugReport.STATUSES,
    titleMax: BugReport.TITLE_MAX,
    bodyMax: BugReport.BODY_MAX
  });
};
