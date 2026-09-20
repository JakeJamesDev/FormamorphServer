const { hourly } = require('./hourly');
const Signal = require('../models/Signal');
const AnonymousLike = require('../models/AnonymousLike');

/**
 * Let go of everything the retention promise says is let go of.
 *
 * Retention is a promise the privacy policy makes in writing, so it is kept by code that runs whether
 * anyone is watching or not: once at boot, to clear whatever expired while the server was down, and then
 * hourly. Unlike the quarantine sweeper there is no lazy read path, because nothing reads these tables on
 * a request an ordinary user makes — the staff views ask for matches inside retention themselves.
 *
 * Two steps, because the two rows expire differently. A Signal is nothing but where an account acted
 * from, so the whole row goes. An Anonymous Like is a like as well as an address, and the like is not
 * the operator's to quietly take away at ninety days, so only the hash goes and the number a listing
 * shows does not move.
 *
 * Each step is caught on its own, the way the event sweeper catches each transition. They share a
 * deadline and nothing else, and a table that will not write must not keep the other one from expiring.
 *
 * Never throws. This runs on a timer nobody is watching; a failure to purge must not take the process down.
 *
 * @param {string} [now] - The instant to measure retention back from, for tests
 * @returns {{signals: number, hashes: number}} Rows deleted, and marks that lost their hash
 */
const sweepSignals = (now = undefined) => {
  const cutoff = Signal.cutoff(now);
  const swept = { signals: 0, hashes: 0 };

  try {
    swept.signals = Signal.deleteBefore(cutoff);
  } catch (error) {
    console.error('Signal sweep failed:', error);
  }

  try {
    swept.hashes = AnonymousLike.blankHashesBefore(cutoff);
  } catch (error) {
    console.error('Anonymous Like hash sweep failed:', error);
  }

  return swept;
};

const startSignalSweeper = () => hourly(sweepSignals);

module.exports = { sweepSignals, startSignalSweeper };
