const Policy = require('../models/Policy');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { STAFF_PROTECTED, canModerate, isAdmin } = require('../config/roles');

/** Mirrors the message composer's caps so both authored surfaces accept the same size of text. */
const TITLE_MAX = 120;
const BODY_MAX = 4000;

/** Ceiling on the tag notice's list, keeping the match set small enough to compare on every publish. */
const MAX_TAGS = 100;

/** What a reader needs to render a popup. Never includes the acceptance version — that is bookkeeping. */
const toPublicDto = (policy) => (policy && policy.enabled && policy.title && policy.body
  ? { title: policy.title, body: policy.body, tags: policy.tags }
  : null);

/** What the admin editor needs, including a disabled or half-written draft. */
const toAdminDto = (policy) => (policy
  ? {
      enabled: policy.enabled,
      title: policy.title,
      body: policy.body,
      tags: policy.tags,
      acceptanceVersion: policy.acceptance_version,
      updatedAt: policy.updated_at
    }
  : { enabled: false, title: '', body: '', tags: [], acceptanceVersion: 1, updatedAt: null });

/**
 * Validate an authored policy.
 * @param {Object} body - Request body
 * @returns {Object} `{ error }` on rejection, otherwise the normalized fields
 */
const parsePolicyBody = (body) => {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  const enabled = body.enabled === true;
  const tags = Array.isArray(body.tags) ? body.tags : [];

  if (title.length > TITLE_MAX) return { error: `Title must be ${TITLE_MAX} characters or fewer` };
  if (text.length > BODY_MAX) return { error: `Body must be ${BODY_MAX} characters or fewer` };
  if (tags.length > MAX_TAGS) return { error: `A policy is limited to ${MAX_TAGS} tags` };

  // Switching it on is what makes it a wall, so that is where the content requirement bites — a draft
  // may be saved half-written as long as it stays off.
  if (enabled && (!title || !text)) {
    return { error: 'A title and body are required before a popup can be enabled' };
  }

  return { enabled, title, body: text, tags };
};

/**
 * @desc    Get the popups that apply to the current user
 * @route   GET /api/policies
 * @access  Private
 */
exports.getPolicies = async (req, res, next) => {
  try {
    const gate = Policy.findById(Policy.UPLOAD_GATE);
    const notice = Policy.findById(Policy.TAG_NOTICE);
    const gateDto = toPublicDto(gate);

    res.status(200).json({
      success: true,
      // `accepted` is true whenever the gate cannot block this user — including when there is no gate —
      // so a client can treat it as "may publish" without repeating the activity rules.
      uploadGate: gateDto
        ? { ...gateDto, accepted: Policy.hasAccepted(Policy.UPLOAD_GATE, req.user.id) }
        : null,
      tagNotice: toPublicDto(notice)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get both policies for editing, including disabled drafts
 * @route   GET /api/policies/manage
 * @access  Private/Admin
 */
exports.getPoliciesForAdmin = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      uploadGate: toAdminDto(Policy.findById(Policy.UPLOAD_GATE)),
      tagNotice: toAdminDto(Policy.findById(Policy.TAG_NOTICE))
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Write a policy
 * @route   PUT /api/policies/:id
 * @access  Private/Admin
 */
exports.savePolicy = async (req, res, next) => {
  try {
    if (!Policy.POLICY_IDS.includes(req.params.id)) {
      return res.status(404).json({ success: false, error: 'Unknown policy' });
    }

    const parsed = parsePolicyBody(req.body);
    if (parsed.error) {
      return res.status(400).json({ success: false, error: parsed.error });
    }

    // Only the gate is accepted, so only the gate can require re-acceptance.
    const requireReaccept = req.params.id === Policy.UPLOAD_GATE && req.body.requireReaccept === true;
    const saved = Policy.save(req.params.id, parsed, requireReaccept);

    res.status(200).json({ success: true, data: toAdminDto(saved) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Accept the upload gate
 * @route   POST /api/policies/upload-gate/accept
 * @access  Private
 */
exports.acceptUploadGate = async (req, res, next) => {
  try {
    if (!Policy.isActive(Policy.UPLOAD_GATE)) {
      return res.status(404).json({ success: false, error: 'There is nothing to accept' });
    }

    Policy.accept(Policy.UPLOAD_GATE, req.user.id);

    res.status(200).json({ success: true, accepted: true });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Record that the user declined the upload gate
 * @route   POST /api/policies/upload-gate/decline
 * @access  Private
 *
 * Nothing is enforced by this — an unanswered gate already blocks publishing. It exists so an admin can
 * tell someone who was asked and said no from someone who has simply never tried to publish.
 */
exports.declineUploadGate = async (req, res, next) => {
  try {
    if (!Policy.isActive(Policy.UPLOAD_GATE)) {
      return res.status(404).json({ success: false, error: 'There is nothing to decline' });
    }

    Policy.accept(Policy.UPLOAD_GATE, req.user.id, 'declined');

    res.status(200).json({ success: true, accepted: false });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Require the gate to be accepted again, by one user or by everyone
 * @route   POST /api/policies/upload-gate/reset
 * @access  Private/Admin
 */
exports.resetUploadGate = async (req, res, next) => {
  try {
    if (!Policy.findById(Policy.UPLOAD_GATE)) {
      return res.status(404).json({ success: false, error: 'There is no upload gate to reset' });
    }

    const { userId } = req.body;

    if (userId) {
      const target = User.findById(userId);
      if (!target) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      // Resetting one person's answer is moderation, done from the user table; staff may do it, subject
      // to the same rule as every other moderation action.
      if (!canModerate(req.user, target)) {
        return res.status(403).json({ success: false, error: STAFF_PROTECTED });
      }

      Policy.resetForUser(Policy.UPLOAD_GATE, userId);
      AuditLog.tryRecord({
        action: 'terms_reset_user',
        actor: req.user,
        targetUser: target,
        targetKind: 'account',
        targetName: target ? target.username : null
      });

      return res.status(200).json({ success: true, scope: 'user' });
    }

    // Asking the entire userbase to agree again is a change to what the site requires, not a moderation
    // action against anybody, so it stays with the administrators.
    if (!isAdmin(req.user)) {
      return res.status(403).json({
        success: false,
        error: 'Only an administrator can reset the terms for everyone'
      });
    }

    // No user named means everyone: one version bump invalidates every acceptance at once. One entry
    // covers it rather than one per account — it was one action, however many people it reached.
    Policy.resetForEveryone(Policy.UPLOAD_GATE);
    AuditLog.tryRecord({ action: 'terms_reset_all', actor: req.user });
    res.status(200).json({ success: true, scope: 'all' });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Which of a publish's tags the tag notice covers
 * @route   POST /api/policies/tag-notice/match
 * @access  Private
 */
exports.matchTags = async (req, res, next) => {
  try {
    const tags = Array.isArray(req.body.tags) ? req.body.tags : [];

    res.status(200).json({ success: true, matched: Policy.matchingTags(tags) });
  } catch (error) {
    next(error);
  }
};
