const { reviewEnabled } = require('../utils/listingReview');

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
