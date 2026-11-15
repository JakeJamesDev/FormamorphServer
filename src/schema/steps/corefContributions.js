const { tableExists } = require('../columns');

/**
 * Character Mentions corrections that players contributed, one row per passage, waiting for staff review.
 *
 * `clusters`, `cluster_entities` and `corrections` are JSON. Offsets are UTF-16 code units, as the client
 * sent them. Account deletion keeps only accepted rows, with the account set null.
 */
const apply = (database) => {
  if (tableExists(database, 'coref_contributions')) return false;

  database.exec(`
    CREATE TABLE coref_contributions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      world_id TEXT NOT NULL,
      passage TEXT NOT NULL,
      passage_sha256 TEXT NOT NULL,
      model_id TEXT NOT NULL,
      model_version INTEGER NOT NULL,
      clusters TEXT NOT NULL,
      cluster_entities TEXT NOT NULL,
      corrections TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'accepted', 'rejected')),
      reviewed_by TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
      FOREIGN KEY (reviewed_by) REFERENCES users (id) ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX idx_coref_contributions_pending
      ON coref_contributions(user_id, world_id, passage_sha256) WHERE state = 'pending';
    CREATE INDEX idx_coref_contributions_state ON coref_contributions(state, created_at);
  `);

  return true;
};

module.exports = { name: 'corefContributions', apply };
