const { reviewEnabled } = require('../utils/listingReview');
const AuditLog = require('../models/AuditLog');
const World = require('../models/World');
const User = require('../models/User');
const { canModerate, isStaff, STAFF_PROTECTED } = require('../config/roles');
const { quarantineDays } = require('../config/quarantine');
const { authorPayload } = require('../utils/authorPayload');

const NOT_FOUND = { success: false, error: 'World not found' };
const NOT_PENDING = { success: false, error: 'This is no longer waiting for review' };
const OWN_LISTING = { success: false, error: 'You cannot review your own listing' };

/**
 * The listing a review route acts on and its author, or the refusal already sent.
 *
 * Applies the staff ladder against the author, so a mod cannot decide on an admin's listing, and refuses
 * staff deciding on their own. With `orAuthor`, the author passes instead.
 *
 * @returns {Object|null} `{ world, author }`, or null when a response was sent
 */
const reviewTarget = (req, res, { orAuthor = false } = {}) => {
  const world = World.findById(req.params.id);
  if (!world) {
    res.status(404).json(NOT_FOUND);
    return null;
  }

  const author = world.author_id ? User.findById(world.author_id) : null;
  const isAuthor = Boolean(req.user) && world.author_id === req.user.id;
  if (orAuthor && isAuthor) return { world, author };

  // A player is told nothing exists, as on every other read of a waiting listing.
  if (!isStaff(req.user)) {
    res.status(404).json(NOT_FOUND);
    return null;
  }
  // A listing submitted before its author's promotion is the one way staff work waits.
  if (isAuthor) {
    res.status(403).json(OWN_LISTING);
    return null;
  }
  if (!canModerate(req.user, author)) {
    res.status(403).json({ success: false, error: STAFF_PROTECTED });
    return null;
  }

  return { world, author };
};

/** The author object a review answer carries, or null for a listing whose account is gone. */
const authorOf = (author) => (author ? authorPayload({
  id: author.id,
  username: author.username,
  avatarFile: author.avatar_file,
  role: author.account_type
}) : null);

/** Log a mod's decision on a pending listing, linked to it by id. */
const recordDecision = (action, actor, { world, author }, snippet = null) => AuditLog.tryRecord({
  action,
  actor,
  targetUser: author && author.id !== actor.id ? author : null,
  targetKind: world.kind || 'world',
  targetName: world.name,
  targetId: world.id,
  snippet
});

/**
 * @desc    Everything waiting for review: contest entries first, then the longest-waiting
 * @route   GET /api/reviews
 * @access  Private/Staff
 */
exports.getQueue = async (req, res, next) => {
  try {
    const data = World.reviewQueue().map((row) => ({
      id: row.id,
      kind: row.kind || 'world',
      name: row.name,
      type: row.quarantined_at ? 'resubmitted' : 'new',
      author: row.author_id ? authorPayload({
        id: row.author_id,
        username: row.author_username,
        avatarFile: row.author_avatar_file,
        role: row.author_account_type
      }) : null,
      contest: row.contest_event_id ? { id: row.contest_event_id, title: row.contest_title } : null,
      queuedAt: row.moderation_queued_at,
      createdAt: row.created_at,
      quarantineExpiresAt: row.quarantined_at ? row.quarantine_expires_at : null
    }));

    res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    How many items wait for review
 * @route   GET /api/reviews/count
 * @access  Private/Staff
 */
exports.getQueueCount = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: { count: World.reviewQueueCount() } });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    The content waiting for review. Counts no download: nobody in the room received it
 * @route   GET /api/reviews/:id/content
 * @access  Private (staff, or the author)
 */
exports.getContent = async (req, res, next) => {
  try {
    const target = reviewTarget(req, res, { orAuthor: true });
    if (!target) return;
    if (!World.isPendingListing(target.world)) return res.status(404).json(NOT_FOUND);

    res.status(200).json({ success: true, data: await World.getContent(target.world.id, req.user) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Put a waiting listing live, as new in the catalog and the follows feed, ending any quarantine
 * @route   POST /api/reviews/:id/approve
 * @access  Private/Staff
 */
exports.approve = async (req, res, next) => {
  try {
    const target = reviewTarget(req, res);
    if (!target) return;

    const approved = World.approvePending(target.world.id);
    if (!approved) return res.status(409).json(NOT_PENDING);

    recordDecision('listing_approved', req.user, target);

    res.status(200).json({ success: true, data: { id: approved.id, listedAt: approved.listed_at } });
  } catch (error) {
    next(error);
  }
};

/**
 * Approve a rejected listing that staff release from quarantine, and send the answer. The caller has
 * applied the staff ladder already.
 *
 * @param {Object} req - The release request
 * @param {Object} res - Its response
 * @param {Object} world - The rejected listing's row
 */
exports.approveOnRelease = (req, res, world) => {
  if (world.author_id === req.user.id) return res.status(403).json(OWN_LISTING);
  if (!World.approveRejected(world.id)) return res.status(409).json(NOT_PENDING);

  const author = world.author_id ? User.findById(world.author_id) : null;
  recordDecision('listing_approved', req.user, { world, author });

  return res.status(200).json({ success: true, data: {} });
};

/**
 * @desc    Reject a waiting listing into quarantine. A resubmission keeps its deadline and ignores
 *          `days`. Answers what the message to the author needs
 * @route   POST /api/reviews/:id/reject
 * @access  Private/Staff
 */
exports.reject = async (req, res, next) => {
  try {
    const target = reviewTarget(req, res);
    if (!target) return;
    if (!World.isPendingListing(target.world)) return res.status(409).json(NOT_PENDING);

    const length = target.world.quarantined_at ? { days: null } : quarantineDays(req.body.days);
    if (length.error) return res.status(400).json({ success: false, error: length.error });

    const rejected = World.rejectPending(target.world.id, length.days);
    if (!rejected) return res.status(409).json(NOT_PENDING);

    recordDecision('listing_rejected', req.user, target, `Deleted on ${rejected.quarantine_expires_at} unless released`);

    res.status(200).json({
      success: true,
      data: {
        id: rejected.id,
        author: authorOf(target.author),
        quarantinedAt: rejected.quarantined_at,
        quarantineExpiresAt: rejected.quarantine_expires_at,
        quarantineExtended: Boolean(rejected.quarantine_extended)
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Whether listing review is on. A client detects the feature by this route answering
 * @route   GET /api/reviews/meta
 * @access  Public
 */
exports.getMeta = async (req, res, next) => {
  try {
    res.status(200).json({ success: true, data: { enabled: reviewEnabled() } });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Recent auto-approvals, newest first, each linked to its listing by `targetId`
 * @route   GET /api/reviews/auto
 * @access  Private/Staff
 */
exports.getAutoApprovals = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);

    const result = AuditLog.getAll({ page, limit, action: 'listing_auto_approved' });

    res.status(200).json({
      success: true,
      total: result.total,
      // The snapshot taken at upload: the listing may have been renamed or deleted since.
      entries: result.entries.map((row) => ({
        id: row.id,
        targetId: row.target_id,
        targetKind: row.target_kind,
        targetName: row.target_name,
        actor: { id: row.actor_id, username: row.actor_username, role: row.actor_role || null },
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    next(error);
  }
};
