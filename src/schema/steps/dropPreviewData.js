const { columnNames } = require('../columns');

/**
 * Drop the listing table's `preview_data` column.
 *
 * It held a base64 copy of the thumbnail already stored on disk, and nothing ever read it back: every
 * response path stripped it, and the thumbnails route has always been the only source of listing art. It
 * was most of the database, carried by every backup and every restore.
 *
 * Dropping a column does not shrink the file. The one-time `VACUUM` that reclaims the space is run by hand
 * with the service stopped, because a vacuum cannot run inside a transaction; the server doc records it.
 */
const apply = (database) => {
  // No table check: `PRAGMA table_info` on a missing table returns an empty list rather than throwing, so
  // a database without the table reads as one without the column, which is the same answer.
  if (!columnNames(database, 'worlds').includes('preview_data')) return false;

  database.exec('ALTER TABLE worlds DROP COLUMN preview_data');

  return true;
};

module.exports = { name: 'dropPreviewData', apply };
