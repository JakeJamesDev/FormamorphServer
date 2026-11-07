const { tableExists } = require('../columns');

/**
 * The Daily Send's live rows: one random key per UTC month, and one row per install per UTC day.
 *
 * `hash` is HMAC-SHA256 of the Install id under its month's key. The unique index on day and hash makes a
 * repeated send a no-op, so the first version that day is the one kept.
 */
const apply = (database) => {
  if (tableExists(database, 'active_install_days')) return false;

  database.exec(`
    CREATE TABLE IF NOT EXISTS active_install_keys (
      month TEXT PRIMARY KEY,
      secret BLOB NOT NULL
    );
    CREATE TABLE active_install_days (
      day TEXT NOT NULL,
      hash TEXT NOT NULL,
      platform TEXT NOT NULL,
      version TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_active_install_days_key ON active_install_days(day, hash);
  `);

  return true;
};

module.exports = { name: 'activeInstalls', apply };
