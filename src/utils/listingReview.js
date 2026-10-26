const Setting = require('../models/Setting');
const World = require('../models/World');
const PendingUpdate = require('../models/PendingUpdate');
const { LISTING_REVIEW, MODERATION_STATES, skipsReview, isApproved } = require('../config/listingReview');

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

/**
 * Whether an edit joins the listing's pending update instead of applying.
 *
 * Only the author's own approved listing holds: when an update already waits, so its approval never
 * overwrites a newer live edit, or when review is on and they do not skip it. Staff on someone else's
 * listing, and a listing not yet approved, apply at once.
 *
 * @param {Object} world - The listing row
 * @param {Object} user - Who is editing
 * @returns {boolean} True when the edit waits for review
 */
const holdsEdit = (world, user) => isApproved(world) && user.id === world.author_id
  && (Boolean(PendingUpdate.findByWorldId(world.id)) || (reviewEnabled() && !skipsReview(user)));

/**
 * What a held side edit answers beside the approved values.
 *
 * @param {string} worldId - World ID
 * @returns {Object} `{ has_pending_update, pending_update }`
 */
const pendingFields = (worldId) => ({
  has_pending_update: true,
  pending_update: PendingUpdate.payloadFor(World.findById(worldId), PendingUpdate.findByWorldId(worldId))
});

module.exports = { reviewEnabled, submissionFor, holdsEdit, pendingFields };
