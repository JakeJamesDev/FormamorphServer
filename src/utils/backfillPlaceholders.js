const db = require('../config/db');
const { thumbnailEquals: storedBytesEqual } = require('./fileStorage');
const { KINDS, rulesFor } = require('../config/kinds');
const { placeholderFor } = require('../config/placeholderThumbnails');

/**
 * The bytes a stand-in thumbnail is stored as. `saveThumbnail` writes the decoded upload without
 * re-encoding it, so every stored copy equals the data-URI's payload.
 *
 * @param {string} kind - A kind with a stand-in
 * @returns {Buffer} The stored bytes
 */
const storedStandIn = (kind) => Buffer.from(placeholderFor(kind).split(',')[1], 'base64');

/**
 * Flag the listings published before the flag existed whose thumbnail is still the stand-in.
 *
 * Only kinds whose rules say `flagsPlaceholder`, so a dictionary is never touched.
 * Already-flagged rows are skipped, so a second run finds nothing. Leaves `updated_at` and `revision`
 * alone: nothing a downloader receives has changed.
 *
 * @param {Object} [options]
 * @param {boolean} [options.write] - Store the flags; without it, only count what would be flagged
 * @returns {{ found: number, flagged: number }} Matching unflagged rows, and how many were flagged
 */
const backfillPlaceholders = ({ write = false } = {}) => {
  const ids = [];

  for (const kind of KINDS.filter((name) => rulesFor(name).flagsPlaceholder)) {
    const standIn = storedStandIn(kind);
    const rows = db.prepare('SELECT id, thumbnail_file FROM worlds WHERE kind = ? AND placeholder = 0').all(kind);

    for (const row of rows) {
      if (storedBytesEqual(row.thumbnail_file, standIn)) ids.push(row.id);
    }
  }

  if (!write) return { found: ids.length, flagged: 0 };

  const flag = db.prepare('UPDATE worlds SET placeholder = 1 WHERE id = ? AND placeholder = 0');
  const flagged = db.transaction(() => ids.reduce((sum, id) => sum + flag.run(id).changes, 0))();

  return { found: ids.length, flagged };
};

module.exports = { backfillPlaceholders };
