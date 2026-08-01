const Feedback = require('../models/Feedback');
const { avatarUrlFor } = require('../utils/avatarUrl');
const { isStaff, roleOf } = require('../config/roles');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

/**
 * A thread as any reader of it sees it. `unread` and `voted` are per-reader, so the caller supplies them.
 *
 * Diagnostics are only ever on a bug: a suggestion is about the game, not about the machine it was
 * written on, so nothing is collected in the first place (see `createThread`).
 */
const toThreadDto = (row, { unread = false, voted = false } = {}) => ({
  id: row.id,
  type: row.type,
  title: row.title,
  category: row.category,
  body: row.body,
  status: row.status,
  reporter: {
    id: row.reporter_id,
    username: row.reporter_username || null,
    avatarUrl: avatarUrlFor(row.reporter_avatar_file)
  },
  // Stored as JSON text; a row written by hand could be malformed, and one bad row must not fail the list.
  // A suggestion's is empty because none was ever stored — masking it here as well would be a second
  // guard for the same thing, and the dead one always looks like it is doing the work.
  diagnostics: safeParse(row.diagnostics),
  locked: Boolean(row.locked_at),
  /** Set once it has been rewritten, so the thread can say "edited" beside the date. */
  editedAt: row.edited_at || null,
  votes: row.vote_count || 0,
  voted,
  commentCount: row.comment_count || 0,
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
    avatarUrl: avatarUrlFor(row.author_avatar_file),
    // What they were when they wrote it, which is what the badge says. Null for an ordinary reply, and
    // for one written before the snapshot existed — those fall back to the live account type, which is
    // the old behavior and the best that can be said about them.
    role: authorRoleOf(row)
  }
});

/**
 * What a reply's author was when they wrote it.
 *
 * The snapshot when there is one; otherwise the live account type, for rows written before the column
 * existed. `normal` becomes null either way — an ordinary reply wears no badge, and a caller checking
 * for one should not have to know the word.
 *
 * @param {Object} row - A `feedback_comments` row joined with its author
 * @returns {string|null} The role, or null
 */
function authorRoleOf(row) {
  const role = row.author_role || row.author_account_type || null;

  return role && role !== 'normal' ? role : null;
}

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

/** The branch a request is about, defaulting to bugs — which is what every caller predating this sent. */
const typeOf = (value) => (Feedback.TYPES.includes(value) ? value : 'bug');

/**
 * @desc    File a bug report or a suggestion
 * @route   POST /api/feedback
 * @access  Private
 */
exports.createThread = async (req, res, next) => {
  try {
    const type = typeOf(req.body.type);
    const title = asText(req.body.title);
    const body = asText(req.body.body);
    const { category } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, error: 'A title is required' });
    }
    if (title.length > Feedback.TITLE_MAX) {
      return res.status(400).json({ success: false, error: `A title is limited to ${Feedback.TITLE_MAX} characters` });
    }
    if (!body) {
      return res.status(400).json({ success: false, error: 'A description is required' });
    }
    if (body.length > Feedback.BODY_MAX) {
      return res.status(400).json({ success: false, error: `A description is limited to ${Feedback.BODY_MAX} characters` });
    }
    // Per type: the two dropdowns share no values but `editor`, `community` and `other`.
    if (!Feedback.CATEGORIES[type].includes(category)) {
      return res.status(400).json({ success: false, error: 'Unknown category' });
    }

    // Diagnostics are whatever the client says about itself, so they are stored as given but bounded —
    // this field is never trusted, only displayed. A suggestion carries none, whatever it sends.
    const diagnostics = type === 'bug' ? req.body.diagnostics : {};
    const encoded = JSON.stringify(diagnostics && typeof diagnostics === 'object' && !Array.isArray(diagnostics) ? diagnostics : {});
    if (encoded.length > Feedback.DIAGNOSTICS_MAX) {
      return res.status(400).json({ success: false, error: 'Diagnostics are too large' });
    }

    const thread = Feedback.create({
      type,
      reporterId: req.user.id,
      title,
      category,
      body,
      diagnostics: JSON.parse(encoded)
    });

    // A suggestion is auto-voted by whoever filed it, so the response says so rather than showing a
    // vote button they would press to no effect.
    res.status(201).json({ success: true, data: toThreadDto(thread, { voted: type === 'suggestion' }) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    List threads — the caller's own, or everyone's
 * @route   GET /api/feedback
 * @access  Private
 */
exports.getThreads = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const type = typeOf(req.query.type);
    // An unknown status is ignored rather than rejected — it falls back to every thread, which is what
    // an unfiltered list already shows.
    const status = Feedback.STATUSES[type].includes(req.query.status) ? req.query.status : null;
    // Same for a category the branch does not have — asking a bug queue for 'interface' falls back to
    // every category rather than an empty list nobody asked for.
    const category = Feedback.CATEGORIES[type].includes(req.query.category) ? req.query.category : null;
    // Likewise an unknown sort: `getAll` falls back to newest.
    const sort = req.query.sort;

    // The queue is public, so `scope=all` is open to anyone: checking whether something is already filed
    // beats filing it twice. Without it the list is the caller's own, which is what the profile opens on.
    const reporterId = req.query.scope === 'all' ? null : req.user.id;

    const result = Feedback.getAll({ page, limit, type, reporterId, status, category, sort });
    const ids = result.threads.map((row) => row.id);
    const unread = Feedback.unreadAmong(ids, req.user);
    const voted = Feedback.votedAmong(ids, req.user.id);

    res.status(200).json({
      success: true,
      count: result.count,
      total: result.total,
      data: result.threads.map((row) => toThreadDto(row, {
        unread: unread.has(row.id),
        voted: voted.has(row.id)
      }))
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Read one thread and its comments. Reading marks it seen for anyone it badges.
 * @route   GET /api/feedback/:id
 * @access  Private (any signed-in account)
 */
exports.getThread = async (req, res, next) => {
  try {
    const thread = Feedback.findById(req.params.id);
    if (!thread) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    if (!Feedback.canRead(thread, req.user)) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const comments = Feedback.comments(thread.id);
    // Only for someone the thread badges. A passing reader has no unread state to clear, and writing a
    // marker anyway would leave a row per thread per curious account. Admins are a party to every bug,
    // and anyone who has written in a suggestion is a party to that.
    const badged = isStaff(req.user)
      ? thread.type === 'bug' || Feedback.hasParticipated(thread, req.user.id)
      : Feedback.hasParticipated(thread, req.user.id);
    if (badged) Feedback.markSeen(thread.id, req.user.id);

    res.status(200).json({
      success: true,
      data: toThreadDto(thread, { voted: Feedback.hasVoted(thread.id, req.user.id) }),
      comments: comments.map(toCommentDto)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Add a comment to a thread
 * @route   POST /api/feedback/:id/comments
 * @access  Private (a bug's reporter or an admin; anyone on an unlocked suggestion)
 */
exports.addComment = async (req, res, next) => {
  try {
    const thread = Feedback.findById(req.params.id);
    if (!thread) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    // Readable by anyone, so a refusal here gives nothing away — it is a plain 403, not a 404.
    if (!Feedback.canWrite(thread, req.user)) {
      return res.status(403).json({
        success: false,
        error: thread.locked_at
          ? 'This thread has been locked'
          : 'Only the reporter and the team can reply here'
      });
    }

    const body = asText(req.body.body);
    if (!body) {
      return res.status(400).json({ success: false, error: 'A comment is required' });
    }
    if (body.length > Feedback.COMMENT_MAX) {
      return res.status(400).json({ success: false, error: `A comment is limited to ${Feedback.COMMENT_MAX} characters` });
    }

    const comment = Feedback.addComment({ feedbackId: thread.id, authorId: req.user.id, body, authorRole: roleOf(req.user) });
    // Writing in a thread means having read it; leaving it unread would badge the author's own reply.
    // It is also what makes them a party to a suggestion from here on.
    Feedback.markSeen(thread.id, req.user.id);

    res.status(201).json({ success: true, data: toCommentDto(comment) });
  } catch (error) {
    next(error);
  }
};

/**
 * Locate a comment for an edit or a delete, and say who may do what to it.
 *
 * Editing is the author's alone — moderation powers do not extend to rewriting what somebody said.
 * Deleting is the author's or a moderator's, which is the only lever there is when an open thread goes
 * bad. A lock stops the author but never the moderators.
 *
 * @param {Object} req - The request, with `params.id` / `params.commentId` and `user`
 * @param {boolean} adminMayAct - Whether a moderator can act on somebody else's comment (delete, not edit)
 * @returns {Object} `{ error }` with a status and message, or `{ comment }` when it may be changed
 */
const commentFor = (req, adminMayAct) => {
  const thread = Feedback.findById(req.params.id);
  if (!thread) {
    return { error: { status: 404, message: 'Not found' } };
  }

  const comment = Feedback.findComment(req.params.commentId);
  if (!comment || comment.feedback_id !== thread.id) {
    return { error: { status: 404, message: 'Comment not found' } };
  }

  const isModerator = isStaff(req.user);
  const isAuthor = comment.author_id === req.user.id;

  if (!isAuthor && !(adminMayAct && isModerator)) {
    return { error: { status: 403, message: 'You can only change your own comments' } };
  }
  // A locked thread is closed to its participants, moderators excepted.
  if (thread.locked_at && !isModerator) {
    return { error: { status: 403, message: 'This thread has been locked' } };
  }

  return { comment };
};

/**
 * @desc    Rewrite one's own comment
 * @route   PUT /api/feedback/:id/comments/:commentId
 * @access  Private (the comment's author)
 */
exports.updateComment = async (req, res, next) => {
  try {
    const { error, comment } = commentFor(req, false);
    if (error) {
      return res.status(error.status).json({ success: false, error: error.message });
    }

    const body = asText(req.body.body);
    if (!body) {
      return res.status(400).json({ success: false, error: 'A comment is required' });
    }
    if (body.length > Feedback.COMMENT_MAX) {
      return res.status(400).json({ success: false, error: `A comment is limited to ${Feedback.COMMENT_MAX} characters` });
    }

    res.status(200).json({ success: true, data: toCommentDto(Feedback.updateComment(comment.id, body)) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete a comment
 * @route   DELETE /api/feedback/:id/comments/:commentId
 * @access  Private (the comment's author, or an admin moderating)
 */
exports.deleteComment = async (req, res, next) => {
  try {
    const { error, comment } = commentFor(req, true);
    if (error) {
      return res.status(error.status).json({ success: false, error: error.message });
    }

    Feedback.deleteComment(comment.id);

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
};


/**
 * Whether this caller may rewrite this thread's prose.
 *
 * A bug is a work item for the team, so a poorly written one can be made useful. A suggestion is
 * somebody's idea on a public board and stays in their words — the same rule every comment follows.
 * A lock closes the reporter's own editing, moderators excepted.
 *
 * @param {Object} thread - The thread row
 * @param {Object} user - The signed-in user
 * @returns {boolean} Whether the title and body may be changed
 */
const mayEditProse = (thread, user) => {
  if (isStaff(user)) return thread.type === 'bug';

  return thread.reporter_id === user.id && !thread.locked_at;
};

/**
 * @desc    Rewrite a report: its prose by whoever owns the words, its filing by the team
 * @route   PUT /api/feedback/:id
 * @access  Private (the reporter, or staff)
 */
exports.updateThread = async (req, res, next) => {
  try {
    const thread = Feedback.findById(req.params.id);
    if (!thread) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const moderator = isStaff(req.user);
    const fields = {};

    // --- The words. Whose they are depends on the branch.
    const wantsProse = req.body.title !== undefined || req.body.body !== undefined;
    if (wantsProse) {
      if (!mayEditProse(thread, req.user)) {
        return res.status(403).json({
          success: false,
          error: thread.locked_at && thread.reporter_id === req.user.id
            ? 'This thread has been locked'
            : 'You cannot rewrite this'
        });
      }

      if (req.body.title !== undefined) {
        const title = asText(req.body.title);
        if (!title) {
          return res.status(400).json({ success: false, error: 'A title is required' });
        }
        if (title.length > Feedback.TITLE_MAX) {
          return res.status(400).json({ success: false, error: `A title is limited to ${Feedback.TITLE_MAX} characters` });
        }
        fields.title = title;
      }

      if (req.body.body !== undefined) {
        const body = asText(req.body.body);
        if (!body) {
          return res.status(400).json({ success: false, error: 'A description is required' });
        }
        if (body.length > Feedback.BODY_MAX) {
          return res.status(400).json({ success: false, error: `A description is limited to ${Feedback.BODY_MAX} characters` });
        }
        fields.body = body;
      }
    }

    // --- The filing. Triage, so the team's alone.
    const wantsFiling = req.body.category !== undefined || req.body.type !== undefined;
    if (wantsFiling && !moderator) {
      return res.status(403).json({ success: false, error: 'Only the team can re-file a report' });
    }

    // A type move takes the category with it: the two lists share only three values, so `crash` has no
    // honest answer on the other side. The caller names the new one rather than having one guessed.
    const nextType = req.body.type === undefined ? thread.type : req.body.type;
    if (!Feedback.TYPES.includes(nextType)) {
      return res.status(400).json({ success: false, error: 'Unknown type' });
    }

    if (nextType !== thread.type) {
      if (req.body.category === undefined) {
        return res.status(400).json({
          success: false,
          error: `Moving this to a ${nextType} needs a ${nextType} category`
        });
      }
      fields.type = nextType;
    }

    if (req.body.category !== undefined) {
      if (!Feedback.CATEGORIES[nextType].includes(req.body.category)) {
        return res.status(400).json({ success: false, error: 'Unknown category' });
      }
      fields.category = req.body.category;
    }

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ success: false, error: 'Nothing to change' });
    }

    const updated = Feedback.update(thread.id, fields);

    // Only when somebody other than the reporter changed it: a person fixing their own typo is not
    // moderation, and a log full of those buries the entries that matter.
    if (thread.reporter_id !== req.user.id) {
      const changed = [];
      if (fields.type) changed.push(`${thread.type} to ${fields.type}`);
      if (fields.category) changed.push(`category: ${thread.category} to ${fields.category}`);
      if (fields.title || fields.body) changed.push('rewrote the report');

      AuditLog.tryRecord({
        action: 'feedback_edited',
        actor: req.user,
        targetUser: thread.reporter_id ? User.findById(thread.reporter_id) : null,
        targetKind: updated.type,
        targetName: updated.title,
        snippet: changed.join('; ')
      });
    }

    res.status(200).json({
      success: true,
      data: toThreadDto(updated, { voted: Feedback.hasVoted(updated.id, req.user.id) })
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Move a thread through triage
 * @route   PUT /api/feedback/:id/status
 * @access  Private/Admin
 */
exports.setStatus = async (req, res, next) => {
  try {
    const thread = Feedback.findById(req.params.id);
    if (!thread) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const { status } = req.body;
    // Checked against this thread's own branch: a suggestion cannot be 'confirmed', a bug cannot be
    // 'planned', and the database's CHECK would reject either anyway.
    if (!Feedback.STATUSES[thread.type].includes(status)) {
      return res.status(400).json({ success: false, error: 'Unknown status' });
    }

    res.status(200).json({ success: true, data: toThreadDto(Feedback.setStatus(thread.id, status)) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Lock a thread to further replies, or unlock it
 * @route   PUT /api/feedback/:id/lock
 * @access  Private/Admin
 */
exports.setLocked = async (req, res, next) => {
  try {
    const thread = Feedback.findById(req.params.id);
    if (!thread) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const locked = req.body.locked !== false;

    res.status(200).json({ success: true, data: toThreadDto(Feedback.setLocked(thread.id, locked)) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Vote for a suggestion, or take a vote back
 * @route   PUT /api/feedback/:id/vote
 * @access  Private
 */
exports.setVote = async (req, res, next) => {
  try {
    const thread = Feedback.findById(req.params.id);
    if (!thread) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }
    // Bugs are not a popularity contest — one person hitting it is reason enough to fix it.
    if (thread.type !== 'suggestion') {
      return res.status(400).json({ success: false, error: 'Only suggestions can be voted for' });
    }

    const voted = req.body.voted !== false;
    Feedback.setVote(thread.id, req.user.id, voted);

    res.status(200).json({ success: true, data: toThreadDto(Feedback.findById(thread.id), { voted }) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete a thread and everything on it
 * @route   DELETE /api/feedback/:id
 * @access  Private/Admin
 */
exports.deleteThread = async (req, res, next) => {
  try {
    const thread = Feedback.findById(req.params.id);
    if (!thread) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    Feedback.delete(thread.id);

    // Admin-only, so this is always a takedown of somebody's report or idea — and it takes the whole
    // conversation with it, which is exactly the kind of disappearance the log exists to explain.
    AuditLog.tryRecord({
      action: 'feedback_deleted',
      actor: req.user,
      targetUser: thread.reporter_id && thread.reporter_id !== req.user.id ? User.findById(thread.reporter_id) : null,
      targetKind: thread.type,
      targetName: thread.title,
      snippet: thread.body
    });

    res.status(200).json({ success: true, data: {} });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    How many of the caller's threads have something new in them, both branches together
 * @route   GET /api/feedback/unread-count
 * @access  Private
 */
exports.getUnreadCount = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, unread: Feedback.unreadCount(req.user) });
  } catch (error) {
    next(error);
  }
};

/** Exposed so the client's field limits and dropdowns can be checked against the server's. */
exports.getMeta = async (_req, res) => {
  res.status(200).json({
    success: true,
    types: Feedback.TYPES,
    categories: Feedback.CATEGORIES,
    statuses: Feedback.STATUSES,
    titleMax: Feedback.TITLE_MAX,
    bodyMax: Feedback.BODY_MAX
  });
};
