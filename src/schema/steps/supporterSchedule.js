const { tableExists } = require('../columns');

/**
 * The per-tier opening dates of a Supporter-only listing: one row per lower tier. A NULL date is the public
 * date, or never without one. No rows opens every tier at once. Rows cascade off the listing.
 */
const apply = (database) => {
  if (tableExists(database, 'supporter_schedule')) return false;

  database.exec(`
    CREATE TABLE supporter_schedule (
      world_id TEXT NOT NULL,
      tier TEXT NOT NULL,
      opens_at TEXT,
      PRIMARY KEY (world_id, tier),
      FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE CASCADE
    )
  `);

  return true;
};

module.exports = { name: 'supporterSchedule', apply };
