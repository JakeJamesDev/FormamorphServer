const { hourly } = require('./hourly');
const Signal = require('../models/Signal');

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
    return Signal.deleteBefore(Signal.cutoff(now));
  } catch (error) {
    console.error('Signal sweep failed:', error);
    return 0;
  }
};

const startSignalSweeper = () => hourly(sweepSignals);

module.exports = { sweepSignals, startSignalSweeper };
