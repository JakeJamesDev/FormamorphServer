const { hourly } = require('./hourly');
const World = require('../models/World');
const AuditLog = require('../models/AuditLog');
const { deleteWorldContent, deleteThumbnail } = require('./fileStorage');

/**
 * Delete every quarantined listing whose deadline has passed.
 *
 * Run from three places, all of them cheap when there is nothing to do: at boot, on an hourly timer, and
 * lazily before the catalog is read. The timer alone would be wrong — a server that was down over a
 * deadline would serve the listing again on the next boot, and one that has been up for weeks would be
 * relying on a single interval never having drifted. Reading the catalog is exactly when correctness
 * matters, so that path checks too.
 *
 * Never throws. This runs on a timer nobody is watching and in front of a request that is about
 * something else; a failure to delete one listing must not take either down.
 *
 * @param {string} [now] - The instant to compare deadlines against, for tests
 * @returns {Promise<number>} How many listings were deleted
 */
const sweepQuarantine = async (now = undefined) => {
  let deleted = 0;

  try {
    const due = World.expiredQuarantines(now);

    for (const world of due) {
      try {
        if (world.content_file) await deleteWorldContent(world.content_file);
        if (world.thumbnail_file) await deleteThumbnail(world.thumbnail_file);
        World.delete(world.id);

        // The actor is the server itself, so the entry carries no username — the log's own wording says
        // "expired" rather than naming somebody who did not do it.
        AuditLog.tryRecord({
          action: 'quarantine_expired',
          actor: null,
          targetUser: world.author_id ? { id: world.author_id, username: world.author_username } : null,
          targetKind: world.kind || 'world',
          targetName: world.name,
          snippet: world.description
        });

        deleted += 1;
      } catch (error) {
        console.error(`Failed to delete expired quarantine ${world.id}:`, error);
      }
    }
  } catch (error) {
    console.error('Quarantine sweep failed:', error);
  }

  return deleted;
};

const startQuarantineSweeper = () => hourly(sweepQuarantine);

module.exports = { sweepQuarantine, startQuarantineSweeper };
