const { addColumns } = require('../columns');

/**
 * The listing review columns on the worlds table.
 *
 * Every listing that exists at deploy counts as approved, which the column default backfills. Each one
 * went live when it was created, so `listed_at` is copied from `created_at`, once, in the run that adds
 * it: a later boot must not fill the null a pending listing holds on purpose.
 */
const apply = (database) => {
  const added = addColumns(database, 'worlds', [
    ['moderation_state', "TEXT NOT NULL DEFAULT 'approved'"],
    ['moderation_queued_at', 'TEXT'],
    ['listed_at', 'TEXT']
  ]);

  if (added.includes('listed_at')) {
    database.exec('UPDATE worlds SET listed_at = created_at');
  }

  return added.length > 0;
};

module.exports = { name: 'moderationState', apply };
