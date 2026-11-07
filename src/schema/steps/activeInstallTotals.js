const { tableExists } = require('../columns');

/**
 * Closed periods of the Daily Send: one count per day or month, platform and version.
 *
 * The unique index backs the Month Close's own check, so no period is ever counted twice.
 */
const apply = (database) => {
  if (tableExists(database, 'active_install_totals')) return false;

  database.exec(`
    CREATE TABLE active_install_totals (
      kind TEXT NOT NULL CHECK (kind IN ('day', 'month')),
      period TEXT NOT NULL,
      platform TEXT NOT NULL,
      version TEXT NOT NULL,
      count INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_active_install_totals_key ON active_install_totals(kind, period, platform, version);
  `);

  return true;
};

module.exports = { name: 'activeInstallTotals', apply };
