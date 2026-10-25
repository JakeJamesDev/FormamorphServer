const { reviewEnabled } = require('../utils/listingReview');
const AuditLog = require('../models/AuditLog');

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
