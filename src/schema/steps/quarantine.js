const { addColumns } = require('../columns');

/**
 * The columns quarantine needs on the worlds table.
 *
 * `quarantine_extended` is per-episode rather than per-listing: releasing clears it, so a listing
 * quarantined again months later gets its one grace extension afresh. Nothing is quarantined until an
 * admin says so, so there is no backfill.
 */
const apply = (database) => addColumns(database, 'worlds', [
  ['quarantined_at', 'TEXT'],
  ['quarantine_expires_at', 'TEXT'],
  ['quarantine_extended', 'INTEGER NOT NULL DEFAULT 0']
]).length > 0;

module.exports = { name: 'quarantine', apply };
