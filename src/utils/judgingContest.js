const Event = require('../models/Event');

/**
 * Whether a listing is being judged: entered, past its contest's deadline, results not announced yet.
 *
 * The whole of the post-deadline lock. It lifts at the announcement rather than at the first place being
 * assigned, so judging finishes before entries go back to being editable. Canceling a contest releases
 * its entries, so a canceled event cannot reach this — and a contest still running has no reason to hold
 * anybody's work still.
 *
 * Shared by every write that changes what an entry installs: its content, and what it requires.
 *
 * @param {Object} world - The world row
 * @returns {Object|null} The contest it is being judged in, or null
 */
const judgingContest = (world) => {
  if (!world.contest_event_id) return null;

  const event = Event.findById(world.contest_event_id);
  if (!event || event.state !== 'ended' || event.results_announced_at) return null;

  return event;
};

/** The answer a locked entry gets, so both routes refuse in the same words. */
const contestLockedBody = (event) => ({
  success: false,
  code: 'CONTEST_LOCKED',
  error: `${event.title} is being judged, so its entries cannot be changed until the results are announced.`
});

module.exports = { judgingContest, contestLockedBody };
