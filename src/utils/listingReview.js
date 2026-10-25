const Setting = require('../models/Setting');
const { LISTING_REVIEW, MODERATION_STATES, skipsReview } = require('../config/listingReview');

/** Whether new submissions wait for review right now. */
const reviewEnabled = () => Setting.get(LISTING_REVIEW) === true;

/**
 * The review columns a new listing starts with, and whether its approval skipped review.
 *
 * With review off nothing is skipped, so nothing is recorded as an auto-approval. An approved listing
 * leaves `listed_at` to `World.create`, which stamps it with the creation instant.
 *
 * @param {Object} user - The publishing account
 * @returns {Object} `{ columns, autoApproved }`; `columns` is what `World.create` takes for review
 */
const submissionFor = (user) => {
  const enabled = reviewEnabled();

  if (enabled && !skipsReview(user)) {
    return {
      columns: {
        moderation_state: MODERATION_STATES.PENDING,
        moderation_queued_at: new Date().toISOString(),
        listed_at: null
      },
      autoApproved: false
    };
  }

  return { columns: { moderation_state: MODERATION_STATES.APPROVED }, autoApproved: enabled };
};

module.exports = { reviewEnabled, submissionFor };
