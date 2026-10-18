const { hourly } = require('./hourly');
const User = require('../models/User');
const { liftExpiredSuspension } = require('./liftSuspension');

/**
 * Lift every suspension whose end has passed, so an account that never signs in is still returned to Normal
 * and the lift is logged.
 *
 * Goes through the shared lift util, never the bare model lift, which logs nothing.
 *
 * Never throws: it runs on a timer nobody is watching, and one bad row must not stop the rest.
 *
 * @param {string} [now] - ISO instant to compare ends against, for tests
 * @returns {number} How many due accounts are no longer suspended, including any another path lifted first
 */
const sweepSuspensions = (now = new Date().toISOString()) => {
  let lifted = 0;

  try {
    for (const user of User.expiredSuspensions(now)) {
      try {
        if (liftExpiredSuspension(user, now).status !== 'suspended') lifted += 1;
      } catch (error) {
        console.error(`Failed to lift expired suspension ${user.id}:`, error);
      }
    }
  } catch (error) {
    console.error('Suspension sweep failed:', error);
  }

  return lifted;
};

const startSuspensionSweeper = () => hourly(sweepSuspensions);

module.exports = { sweepSuspensions, startSuspensionSweeper };
