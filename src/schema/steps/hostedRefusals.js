const { tableExists } = require('../columns');

/**
 * Per-day totals of refused Formamorph AI calls, one row per UTC day, account, refusal code and tier.
 *
 * `tier` is '' for a refusal before entitlement, since SQLite treats NULLs as distinct in a unique index.
 * `user_id` has no foreign key: erasure sets it null and the total stays, as on usage rows.
 */
const apply = (database) => {
  if (tableExists(database, 'hosted_refusals')) return false;

  database.exec(`
    CREATE TABLE hosted_refusals (
      id INTEGER PRIMARY KEY,
      day TEXT NOT NULL,
      user_id TEXT,
      subject TEXT,
      tier TEXT NOT NULL,
      code TEXT NOT NULL,
      count INTEGER NOT NULL,
      first_at TEXT NOT NULL,
      last_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_hosted_refusals_key ON hosted_refusals(day, user_id, code, tier);
  `);

  return true;
};

module.exports = { name: 'hostedRefusals', apply };
