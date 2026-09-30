const { addColumns } = require('../columns');

/**
 * The count of Changelog Entries on each listing.
 *
 * The changelog table shipped before this column, so a live database holds entries no counter saw. The
 * column is counted from them once, in the run that adds it; after that the changelog writes keep it.
 * The backfill leaves `updated_at` alone, as every changelog write does.
 */
const apply = (database) => {
  if (addColumns(database, 'worlds', [['changelog_count', 'INTEGER NOT NULL DEFAULT 0']]).length === 0) {
    return false;
  }

  database.exec(`
    UPDATE worlds
    SET changelog_count = (SELECT COUNT(*) FROM world_changelog c WHERE c.world_id = worlds.id)
  `);

  return true;
};

module.exports = { name: 'changelogCount', apply };
