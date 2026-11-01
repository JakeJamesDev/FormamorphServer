const { addColumns } = require('../columns');

/**
 * Staff grants of a Formamorph AI tier, the per-week warning acknowledgments, and the model a usage row
 * was admitted on.
 *
 * A grant is its own spend subject (`grant:<id>`), so usage rows never point at it. Grants and
 * acknowledgments belong to the account and go with it; the usage rows stay.
 */
const apply = (database) => {
  const before = database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;

  database.exec(`
    CREATE TABLE IF NOT EXISTS hosted_grants (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL,
      tier TEXT NOT NULL CHECK (tier IN ('supporter', 'supporter_plus', 'supporter_top')),
      ends_at TEXT NOT NULL,
      created_by TEXT,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_hosted_grants_user ON hosted_grants(user_id);

    CREATE TABLE IF NOT EXISTS hosted_warning_acks (
      user_id TEXT NOT NULL,
      week TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      PRIMARY KEY (user_id, week, threshold),
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );
  `);

  const added = addColumns(database, 'hosted_usage', [['model', 'TEXT']]);
  const after = database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n;

  return added.length > 0 || after > before;
};

module.exports = { name: 'hostedGrants', apply };
