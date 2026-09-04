const Policy = require('../models/Policy');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { STAFF_PROTECTED, canModerate, isAdmin } = require('../config/roles');
const { BODY_MAX } = require('../config/policies');

/** Mirrors the message composer's cap so both authored surfaces accept the same size of title. */
const TITLE_MAX = 120;

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
 * @param {string} id - Policy ID, which decides how long a body may be
 * @param {Object} body - Request body
 * @returns {Object} `{ error }` on rejection, otherwise the normalized fields
 */
const parsePolicyBody = (id, body) => {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  const enabled = body.enabled === true;
  const tags = Array.isArray(body.tags) ? body.tags : [];
  const bodyMax = BODY_MAX[id];

  if (title.length > TITLE_MAX) return { error: `Title must be ${TITLE_MAX} characters or fewer` };
  if (text.length > bodyMax) return { error: `Body must be ${bodyMax} characters or fewer` };
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
    /** A popup the user answers, carrying whether this user already has. */
    const answerable = (id) => {
      const dto = toPublicDto(Policy.findById(id));
      return dto ? { ...dto, accepted: Policy.hasAccepted(id, req.user.id) } : null;
    };

    res.status(200).json({
      success: true,
      // `accepted` is true whenever the gate cannot block this user — including when there is no gate —
      // so a client can treat it as "may publish" without repeating the activity rules.
      uploadGate: answerable(Policy.UPLOAD_GATE),
      tagNotice: toPublicDto(Policy.findById(Policy.TAG_NOTICE)),
      // Null while the policy is off, which is how it ships: a client that finds nothing here prompts for
      // nothing, and the server refuses nothing either.
      privacyPolicy: answerable(Policy.PRIVACY_POLICY)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Read the Privacy Policy without signing in
 * @route   GET /api/policies/privacy-policy
 * @access  Public
 *
 * The one policy a stranger may read, because registration shows it before the account exists and that
 * screen has no token. The same text is published on the public site, so this discloses nothing new — but
 * the row here is the canonical copy, and a client that read the website instead could show stale wording.
 *
 * Carries no acceptance: a signed-out reader is nobody, and there is no answer to report.
 */
exports.getPrivacyPolicy = async (req, res, next) => {
  try {
    const policy = toPublicDto(Policy.findById(Policy.PRIVACY_POLICY));

    if (!policy) {
      return res.status(404).json({ success: false, error: 'There is no privacy policy' });
    }

    res.status(200).json({ success: true, privacyPolicy: { title: policy.title, body: policy.body } });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get every policy for editing, including disabled drafts
 * @route   GET /api/policies/manage
 * @access  Private/Admin
 */
exports.getPoliciesForAdmin = async (req, res, next) => {
  try {
    res.status(200).json({
      success: true,
      uploadGate: toAdminDto(Policy.findById(Policy.UPLOAD_GATE)),
      tagNotice: toAdminDto(Policy.findById(Policy.TAG_NOTICE)),
      privacyPolicy: toAdminDto(Policy.findById(Policy.PRIVACY_POLICY))
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

    const parsed = parsePolicyBody(req.params.id, req.body);
    if (parsed.error) {
      return res.status(400).json({ success: false, error: parsed.error });
    }

    // Only a policy somebody answers can be asked for again; the tag notice is told, never agreed to.
    const requireReaccept =
      Policy.ANSWERED_POLICY_IDS.includes(req.params.id) && req.body.requireReaccept === true;
    const saved = Policy.save(req.params.id, parsed, requireReaccept);

    res.status(200).json({ success: true, data: toAdminDto(saved) });
  } catch (error) {
    next(error);
  }
};

/**
 * Build the handler that records one answer to one policy.
 *
 * The two answers differ only in what is stored and what a missing policy is called, and the two policies
 * that take an answer differ only in which row they write. One shape rather than four copies of it.
 *
 * A decline enforces nothing by itself: an unanswered policy already refuses whatever it governs. It
 * exists so an admin can tell someone who was asked and said no from someone who was never asked.
 *
 * @param {string} policyId - Which policy is being answered
 * @param {string} response - `'accepted'` or `'declined'`
 * @returns {Function} Express handler
 */
const answerHandler = (policyId, response) => {
  const accepted = response === 'accepted';
  const missing = `There is nothing to ${accepted ? 'accept' : 'decline'}`;

  return async (req, res, next) => {
    try {
      if (!Policy.isActive(policyId)) {
        return res.status(404).json({ success: false, error: missing });
      }

      Policy.accept(policyId, req.user.id, response);

      res.status(200).json({ success: true, accepted });
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Build the handler that asks for a policy to be answered again — by one user, or by everyone.
 *
 * @param {string} policyId - Which policy to reset
 * @param {Object} copy - `{ missing, notAdmin, userAction, allAction }`: the two refusals, and the audit
 *   actions the two scopes are recorded under
 * @returns {Function} Express handler
 */
const resetHandler = (policyId, copy) => async (req, res, next) => {
  try {
    if (!Policy.findById(policyId)) {
      return res.status(404).json({ success: false, error: copy.missing });
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

      Policy.resetForUser(policyId, userId);
      AuditLog.tryRecord({
        action: copy.userAction,
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
      return res.status(403).json({ success: false, error: copy.notAdmin });
    }

    // No user named means everyone: one version bump invalidates every acceptance at once. One entry
    // covers it rather than one per account — it was one action, however many people it reached.
    Policy.resetForEveryone(policyId);
    AuditLog.tryRecord({ action: copy.allAction, actor: req.user });
    res.status(200).json({ success: true, scope: 'all' });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Accept the upload gate
 * @route   POST /api/policies/upload-gate/accept
 * @access  Private
 */
exports.acceptUploadGate = answerHandler(Policy.UPLOAD_GATE, 'accepted');

/**
 * @desc    Record that the user declined the upload gate
 * @route   POST /api/policies/upload-gate/decline
 * @access  Private
 */
exports.declineUploadGate = answerHandler(Policy.UPLOAD_GATE, 'declined');

/**
 * @desc    Require the gate to be accepted again, by one user or by everyone
 * @route   POST /api/policies/upload-gate/reset
 * @access  Private/Admin
 */
exports.resetUploadGate = resetHandler(Policy.UPLOAD_GATE, {
  missing: 'There is no upload gate to reset',
  notAdmin: 'Only an administrator can reset the terms for everyone',
  userAction: 'terms_reset_user',
  allAction: 'terms_reset_all'
});

/**
 * @desc    Accept the Privacy Policy
 * @route   POST /api/policies/privacy-policy/accept
 * @access  Private
 */
exports.acceptPrivacyPolicy = answerHandler(Policy.PRIVACY_POLICY, 'accepted');

/**
 * @desc    Record that the user declined the Privacy Policy
 * @route   POST /api/policies/privacy-policy/decline
 * @access  Private
 */
exports.declinePrivacyPolicy = answerHandler(Policy.PRIVACY_POLICY, 'declined');

/**
 * @desc    Require the Privacy Policy to be accepted again, by one user or by everyone
 * @route   POST /api/policies/privacy-policy/reset
 * @access  Private/Admin
 */
exports.resetPrivacyPolicy = resetHandler(Policy.PRIVACY_POLICY, {
  missing: 'There is no privacy policy to reset',
  notAdmin: 'Only an administrator can reset the privacy policy for everyone',
  userAction: 'privacy_reset_user',
  allAction: 'privacy_reset_all'
});

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
