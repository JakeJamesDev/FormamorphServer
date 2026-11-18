const World = require('../models/World');
const { supporterTierOf } = require('../utils/supporterAccess');
const { perReader } = require('../utils/perReader');

/**
 * Tier-based for everyone, staff and authors included: a client that checks at each start installs what
 * this lists, and a revision above its copy means an update.
 *
 * @desc    Get the signed-in account's Supporter content state
 * @route   GET /api/supporter-content/entitlement
 * @access  Private
 */
exports.getEntitlement = async (req, res, next) => {
  try {
    const tier = supporterTierOf(req.user.id);
    const qualifies = tier !== null;

    perReader(res);
    res.status(200).json({
      success: true,
      data: {
        qualifies,
        tier,
        items: qualifies ? World.supporterOnlyItems() : [],
        expired: qualifies ? World.expiredSupporterItems() : []
      }
    });
  } catch (error) {
    next(error);
  }
};
