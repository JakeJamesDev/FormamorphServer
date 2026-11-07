const { tableExists } = require('../columns');

const TABLES = ['world_download_days', 'hidden_gem_rotations', 'hidden_gem_picks'];

/**
 * The per-day download log and the Hidden Gem rotations. A bucket holds a count and nothing about who
 * downloaded. Everything cascades off the listing, and a pick off its rotation.
 */
const apply = (database) => {
  const missing = TABLES.filter((name) => !tableExists(database, name));

  database.exec(`
    CREATE TABLE IF NOT EXISTS world_download_days (
      world_id TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (world_id, day),
      FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS hidden_gem_rotations (
      id INTEGER PRIMARY KEY,
      rotated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hidden_gem_picks (
      rotation_id INTEGER NOT NULL,
      world_id TEXT NOT NULL,
      PRIMARY KEY (rotation_id, world_id),
      FOREIGN KEY (rotation_id) REFERENCES hidden_gem_rotations (id) ON DELETE CASCADE,
      FOREIGN KEY (world_id) REFERENCES worlds (id) ON DELETE CASCADE
    );
  `);

  return missing.length > 0;
};

module.exports = { name: 'hiddenGems', apply };
