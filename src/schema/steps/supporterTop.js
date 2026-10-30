const { tableExists, columnNames } = require('../columns');

/**
 * Let `patreon_links.tier` hold the third tier key, `supporter_top`.
 *
 * SQLite cannot change a CHECK in place, so this rebuilds the table with the wider constraint and copies
 * every row across. The table's CHECK text says whether this has run. Nothing points at `patreon_links`
 * and it has no named index, so the rebuild drops no reference. It runs with `foreign_keys` on, inside the
 * step runner's transaction, like `placementTies`.
 */

const TOP_TIER_TABLE = `
  CREATE TABLE patreon_links_top (
    user_id TEXT PRIMARY KEY,
    patreon_user_id TEXT NOT NULL UNIQUE,
    tier TEXT CHECK (tier IN ('supporter', 'supporter_plus', 'supporter_top')),
    pledge_start TEXT,
    show_flair INTEGER NOT NULL DEFAULT 1,
    checked_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  )
`;

const apply = (database) => {
  if (!tableExists(database, 'patreon_links')) return false;

  const { sql } = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='patreon_links'").get();
  if (sql.includes('supporter_top')) return false;

  const columns = columnNames(database, 'patreon_links').join(', ');

  database.exec(TOP_TIER_TABLE);
  database.exec(`INSERT INTO patreon_links_top (${columns}) SELECT ${columns} FROM patreon_links`);
  database.exec('DROP TABLE patreon_links');
  database.exec('ALTER TABLE patreon_links_top RENAME TO patreon_links');

  return true;
};

module.exports = { name: 'supporterTop', apply };
