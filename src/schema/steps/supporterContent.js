const { addColumns } = require('../columns');

/**
 * The columns the Supporter content channel needs. Staff set both, so nothing is flagged or revoked until
 * they say so and there is no backfill.
 */
const apply = (database) => {
  const listings = addColumns(database, 'worlds', [
    ['supporter_only', 'INTEGER NOT NULL DEFAULT 0']
  ]);
  const accounts = addColumns(database, 'users', [
    ['supporter_content_revoked_at', 'TEXT']
  ]);

  return listings.length + accounts.length > 0;
};

module.exports = { name: 'supporterContent', apply };
