const Message = require('../models/Message');
const User = require('../models/User');
const { STAFF_PROTECTED, canModerate, isAdmin } = require('../config/roles');

/** Composer limits, enforced here as well as in the client so a hand-rolled request can't exceed them. */
const SUBJECT_MAX = 120;
const BODY_MAX = 4000;

/** Ceiling on one multi-select send, keeping the insert transaction bounded. */
const MAX_RECIPIENTS = 200;

/** A message as its reader sees it. The generic sender label is the client's to render. */
const toInboxDto = (row) => ({
  id: row.id,
  subject: row.subject,
  body: row.body,
  severity: row.severity,
  senderAs: row.sender_as,
  senderName: row.sender_as === 'username' ? row.sender_username : null,
  broadcast: row.recipient_id === null,
  scope: row.scope,
  createdAt: row.created_at,
  editedAt: row.edited_at || null,
  readAt: row.read_at || null
});

/** A message as the sending admin sees it, with whichever receipt shape its audience implies. */
const toSentDto = (row) => {
  const broadcast = row.recipient_id === null;

  return {
    id: row.id,
    subject: row.subject,
    body: row.body,
    severity: row.severity,
    senderAs: row.sender_as,
    senderName: row.sender_as === 'username' ? row.sender_username : null,
    broadcast,
    scope: row.scope,
    createdAt: row.created_at,
    editedAt: row.edited_at || null,
    recalledAt: row.recalled_at || null,
    recipient: broadcast
      ? null
      : {
          id: row.recipient_id,
          username: row.recipient_username,
          readAt: row.recipient_read_at || null,
          dismissedAt: row.recipient_dismissed_at || null
        },
    // Broadcasts report progress instead: how many of the accounts eligible to see it have read it.
    readCount: broadcast ? row.read_count : null,
    eligibleCount: broadcast ? row.eligible_count : null
  };
};

/**
 * Validate and normalize a composer payload.
 * @param {Object} body - Request body
 * @returns {Object} `{ error }` on rejection, otherwise the normalized fields
 */
const parseComposerBody = (body) => {
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const messageBody = typeof body.body === 'string' ? body.body.trim() : '';
  const severity = body.severity || 'info';
  const senderAs = body.senderAs || 'team';
  const scope = body.scope || 'existing';

  if (!subject) return { error: 'Subject is required' };
  if (subject.length > SUBJECT_MAX) return { error: `Subject must be ${SUBJECT_MAX} characters or fewer` };
  if (!messageBody) return { error: 'Message body is required' };
  if (messageBody.length > BODY_MAX) return { error: `Message body must be ${BODY_MAX} characters or fewer` };
  if (!Message.SEVERITIES.includes(severity)) return { error: 'Invalid message severity' };
  if (!Message.SENDER_MODES.includes(senderAs)) return { error: 'Invalid sender attribution' };
  if (!Message.SCOPES.includes(scope)) return { error: 'Invalid message scope' };

  return { subject, body: messageBody, severity, senderAs, scope };
};

/**
 * @desc    Get the current user's inbox
 * @route   GET /api/messages
 * @access  Private
 */
exports.getInbox = async (req, res, next) => {
  try {
    // Clamped the same way the admin user list is, so a hand-rolled limit can't dump every message.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);

    const result = Message.getInbox(req.user.id, { limit });

    res.status(200).json({
      success: true,
      count: result.messages.length,
      // `total` is everything visible, `count` is what this response carries — they differ once the
      // limit bites, which is how the client knows the inbox was truncated.
      total: result.total,
      unread: result.unread,
      data: result.messages.map(toInboxDto)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get the current user's unread message count
 * @route   GET /api/messages/unread-count
 * @access  Private
 */
exports.getUnreadCount = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      unread: Message.getUnreadCount(req.user.id)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Mark a message read
 * @route   POST /api/messages/:id/read
 * @access  Private (suspended accounts included)
 */
exports.markRead = async (req, res, next) => {
  try {
    // A message the caller cannot see is a 404 rather than a 403: whether some other user's message
    // exists is not theirs to learn, and a state row for it would corrupt that message's receipts.
    if (!Message.isVisibleTo(req.params.id, req.user.id)) {
      return res.status(404).json({
        success: false,
        error: 'Message not found'
      });
    }

    res.status(200).json({
      success: true,
      readAt: Message.markRead(req.params.id, req.user.id)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Dismiss a message from the current user's inbox
 * @route   DELETE /api/messages/:id
 * @access  Private (suspended accounts included)
 */
exports.dismiss = async (req, res, next) => {
  try {
    if (!Message.isVisibleTo(req.params.id, req.user.id)) {
      return res.status(404).json({
        success: false,
        error: 'Message not found'
      });
    }

    // A pinned message stays until an admin unpins or recalls it. The client hides the button, but the
    // rule lives here — hiding a control is not a guard.
    const message = Message.findById(req.params.id);
    if (message.scope === 'pinned') {
      return res.status(403).json({
        success: false,
        error: 'This message cannot be dismissed'
      });
    }

    res.status(200).json({
      success: true,
      dismissedAt: Message.dismiss(req.params.id, req.user.id)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Send a message to one user, several users, or everyone
 * @route   POST /api/messages
 * @access  Private/Admin
 */
exports.sendMessage = async (req, res, next) => {
  try {
    const parsed = parseComposerBody(req.body);
    if (parsed.error) {
      return res.status(400).json({ success: false, error: parsed.error });
    }

    const broadcast = req.body.broadcast === true;
    const recipientIds = Array.isArray(req.body.recipientIds) ? [...new Set(req.body.recipientIds)] : [];
    // Writing to one person is a moderation tool — a suspension notice, a takedown explanation — so any
    // staff account may. Speaking to the whole userbase at once is not, and stays with the administrators.
    if (broadcast && !isAdmin(req.user)) {
      return res.status(403).json({
        success: false,
        error: 'Only an administrator can message everyone'
      });
    }

    if (broadcast && recipientIds.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'A broadcast cannot also name recipients'
      });
    }

    if (!broadcast && recipientIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one recipient is required'
      });
    }

    // A direct message goes to one named person, so widening its audience means nothing — but pinning
    // it (making it permanent) does. Rejecting rather than ignoring keeps a client that sets `new` on a
    // 1:1 send from believing something happened.
    if (parsed.scope === 'new' && !broadcast) {
      return res.status(400).json({
        success: false,
        error: 'Reaching new accounts applies to broadcasts only'
      });
    }

    // Staff moderate the room, not each other: a notice is an action taken against somebody.
    const protectedRecipient = recipientIds
      .map((id) => User.findById(id))
      .find((recipient) => recipient && !canModerate(req.user, recipient));
    if (protectedRecipient) {
      return res.status(403).json({ success: false, error: STAFF_PROTECTED });
    }

    if (recipientIds.length > MAX_RECIPIENTS) {
      return res.status(400).json({
        success: false,
        error: `A single send is limited to ${MAX_RECIPIENTS} recipients`
      });
    }

    const fields = {
      senderId: req.user.id,
      senderAs: parsed.senderAs,
      subject: parsed.subject,
      body: parsed.body,
      severity: parsed.severity,
      scope: parsed.scope
    };

    if (broadcast) {
      const created = Message.create({ ...fields, recipientId: null });
      return res.status(201).json({ success: true, count: 1, data: [toSentDto(created)] });
    }

    // Every named recipient must exist before anything is written, so a single bad ID can't leave a
    // partial send behind.
    const missing = recipientIds.filter((id) => !User.findById(id));
    if (missing.length > 0) {
      return res.status(404).json({
        success: false,
        error: 'One or more recipients were not found'
      });
    }

    const created = Message.createForRecipients(recipientIds, fields);

    res.status(201).json({
      success: true,
      count: created.length,
      data: created.map(toSentDto)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    List sent messages, narrowed by `userId` (one user's 1:1 history) or `audience`
 * @route   GET /api/messages/sent
 * @access  Private/Admin
 */
exports.getSent = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
    const recipientId = req.query.userId || null;
    // Anything other than the two known values is treated as no filter rather than rejected — an
    // unknown value listing everything is harmless here, and admin surfaces always send one of the two.
    const audience = ['direct', 'broadcast'].includes(req.query.audience) ? req.query.audience : null;

    const result = Message.getSent({ page, limit, recipientId, audience });

    res.status(200).json({
      success: true,
      count: result.count,
      total: result.total,
      data: result.messages.map(toSentDto)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Edit a sent message
 * @route   PUT /api/messages/sent/:id
 * @access  Private/Admin
 */
exports.editMessage = async (req, res, next) => {
  try {
    const message = Message.findById(req.params.id);
    if (!message) {
      return res.status(404).json({
        success: false,
        error: 'Message not found'
      });
    }

    // A moderator may take back or correct what they sent; anything else — including a broadcast, which
    // only an administrator could have sent — stays with the administrators.
    if (!isAdmin(req.user) && message.sender_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'You can only change messages you sent'
      });
    }

    // Recall is final: a recalled message is a closed record, and editing it back into inboxes would
    // make the audit trail mean two different things. Send a new message instead.
    if (message.recalled_at) {
      return res.status(409).json({
        success: false,
        error: 'A recalled message cannot be edited'
      });
    }

    const parsed = parseComposerBody(req.body);
    if (parsed.error) {
      return res.status(400).json({ success: false, error: parsed.error });
    }

    // Same rule as sending: only a broadcast has an audience to widen.
    if (parsed.scope === 'new' && message.recipient_id !== null) {
      return res.status(400).json({
        success: false,
        error: 'Reaching new accounts applies to broadcasts only'
      });
    }

    const updated = Message.update(req.params.id, parsed);

    // Opt-in, because most edits are typo fixes. When asked, the message lands as a fresh delivery:
    // receipts restart from zero and anyone who had dismissed it gets it back.
    if (req.body.renotify === true) {
      Message.resetReaderState(req.params.id);
    }

    res.status(200).json({
      success: true,
      data: toSentDto(Message.getSentById(req.params.id) || updated)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Recall a sent message
 * @route   DELETE /api/messages/sent/:id
 * @access  Private/Admin
 */
exports.recallMessage = async (req, res, next) => {
  try {
    const message = Message.findById(req.params.id);
    if (!message) {
      return res.status(404).json({
        success: false,
        error: 'Message not found'
      });
    }

    // A moderator may take back or correct what they sent; anything else — including a broadcast, which
    // only an administrator could have sent — stays with the administrators.
    if (!isAdmin(req.user) && message.sender_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        error: 'You can only change messages you sent'
      });
    }

    res.status(200).json({
      success: true,
      recalledAt: Message.recall(req.params.id).recalled_at
    });
  } catch (error) {
    next(error);
  }
};
