const Signal = require('../models/Signal');

/** How often the timer runs. Retention is 90 days, so hourly is far finer than it needs to be. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Delete every Signal past its retention.
 *
 * Retention is a promise the privacy policy makes in writing, so it is kept by code that runs whether
 * anyone is watching or not: once at boot, to clear whatever expired while the server was down, and then
 * hourly. Unlike the quarantine sweeper there is no lazy read path, because nothing reads this table on a
 * request an ordinary user makes — the staff views ask for matches inside retention themselves.
 *
 * Never throws. This runs on a timer nobody is watching; a failure to purge must not take the process down.
 *
 * @param {string} [now] - The instant to measure retention back from, for tests
 * @returns {number} How many rows were deleted
 */
const sweepSignals = (now = undefined) => {
  try {
    const at = now ? new Date(now).getTime() : Date.now();
    const cutoff = new Date(at - Signal.RETENTION_DAYS * DAY_MS).toISOString();

    return Signal.deleteBefore(cutoff);
  } catch (error) {
    console.error('Signal sweep failed:', error);
    return 0;
  }
};

/**
 * Start the hourly timer. Unref'd so it never holds the process open on its own — a pending sweep must not
 * be the reason a shutdown hangs.
 *
 * @returns {Object} The interval handle, so a caller can stop it
 */
const startSignalSweeper = () => {
  const timer = setInterval(() => { sweepSignals(); }, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
};

module.exports = { sweepSignals, startSignalSweeper, SWEEP_INTERVAL_MS };
