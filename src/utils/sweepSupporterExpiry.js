const { hourly } = require('./hourly');
const World = require('../models/World');
const AuditLog = require('../models/AuditLog');
const { clearListingCache } = require('./supporterProcessing');

/**
 * Finish every Supporter-only listing whose end date has passed: clear the flag, move the content to the
 * public area, drop the per-account cache and record the expiry.
 *
 * Reads are already exact without this, because the read-time helper checks the date. The sweep only tidies
 * the stored state, so a missed tick is invisible to a player. A second run finds nothing due.
 *
 * Never throws: it runs on a timer nobody watches.
 *
 * @param {number} [now] - Epoch milliseconds, for tests
 * @returns {Promise<number>} How many listings it finished
 */
const sweepSupporterExpiry = async (now = Date.now()) => {
  let finished = 0;

  try {
    for (const world of World.dueSupporterExpiries(now)) {
      try {
        World.expireSupporterOnly(world.id, new Date(now).toISOString());
        await clearListingCache(world.id);
        AuditLog.tryRecord({
          action: 'listing_supporter_expired',
          actor: null,
          targetKind: world.kind || 'world',
          targetName: world.name,
          targetId: world.id
        });
        finished += 1;
      } catch (error) {
        console.error(`Failed to finish the Supporter-only window of ${world.id}:`, error);
      }
    }
  } catch (error) {
    console.error('Supporter expiry sweep failed:', error);
  }

  return finished;
};

const startSupporterExpirySweeper = () => hourly(sweepSupporterExpiry);

module.exports = { sweepSupporterExpiry, startSupporterExpirySweeper };
