const fs = require('fs');
const World = require('../models/World');
const { CACHE_PREFIX } = require('./supporterProcessing');
const { supporterStorageDir, deleteSupporterFile } = require('./fileStorage');

// `processed-<listing id>-v<version>-r<revision>-<user id>.json`
const LISTING_OF = new RegExp(`^${CACHE_PREFIX}(.+?)-v[0-9a-f]{12}-r\\d+-`);

/**
 * Delete the per-account cache files of every listing that is not a Mascot. Worlds are processed on each
 * request, so these copies are dead weight. A file of a listing that no longer exists goes too.
 *
 * @param {Object} [options]
 * @param {boolean} [options.write] - Delete the files; without it, only count them
 * @returns {Promise<{ found: number, deleted: number }>} Matching files, and how many were deleted
 */
const clearWorldProcessedCache = async ({ write = false } = {}) => {
  const doomed = fs.readdirSync(supporterStorageDir).filter((name) => {
    const id = LISTING_OF.exec(name)?.[1];
    return id !== undefined && World.findById(id)?.kind !== 'mascot';
  });

  if (write) await Promise.all(doomed.map(deleteSupporterFile));
  return { found: doomed.length, deleted: write ? doomed.length : 0 };
};

module.exports = { clearWorldProcessedCache };
