const User = require('../models/User');
const { eraseUser } = require('./eraseUser');
const { graceCutoff } = require('../config/accountDeletion');

/** How often the timer runs. The grace period is seven days, so hourly is far finer than it needs to be. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Erase every account whose grace period has run out.
 *
 * Run at boot to catch up whatever came due while the server was down, then hourly. There is no lazy read
 * path, unlike quarantine: nothing an ordinary request reads depends on this having run, because the
 * account and its work stay visible for the whole window either way.
 *
 * Never throws, and one account that cannot be erased does not stop the rest. The failed one keeps its
 * stamp and comes up again on the next tick.
 *
 * @param {string} [now] - The instant to measure the grace period back from, for tests
 * @returns {Promise<number>} How many accounts were erased
 */
const sweepDeletions = async (now = undefined) => {
  let erased = 0;

  try {
    const due = User.deletionsRequestedBefore(graceCutoff(now));

    for (const user of due) {
      try {
        await eraseUser(user, { removeContent: user.deletion_removes_content === 1 });
        erased += 1;
      } catch (error) {
        console.error(`Failed to erase account ${user.username}:`, error);
      }
    }
  } catch (error) {
    console.error('Deletion sweep failed:', error);
  }

  return erased;
};

/**
 * Start the hourly timer. Unref'd so it never holds the process open on its own — a pending sweep must not
 * be the reason a shutdown hangs.
 *
 * @returns {Object} The interval handle, so a caller can stop it
 */
const startDeletionSweeper = () => {
  const timer = setInterval(() => { void sweepDeletions(); }, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
};

module.exports = { sweepDeletions, startDeletionSweeper, SWEEP_INTERVAL_MS };
