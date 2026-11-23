const { tableExists } = require('../columns');

/**
 * The start pictures a world's client chose for the Supporter mark, as a JSON list of `{ entityId, mediaId }`.
 * Its own table, so no listing row, catalog projection or payload can carry it. `held` 0 is the live
 * revision's picks, 1 the picks of a held update's content. Rows cascade off the listing.
 */
const apply = (database) => {
  if (tableExists(database, 'world_mark_picks')) return false;

  database.exec(`
    CREATE TABLE world_mark_picks (
      world_id TEXT NOT NULL,
      held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1)),
      picks TEXT NOT NULL,
      PRIMARY KEY (world_id, held),
      FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE CASCADE
    )
  `);

  return true;
};

module.exports = { name: 'markPicks', apply };
