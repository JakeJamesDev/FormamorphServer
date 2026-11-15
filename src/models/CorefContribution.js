const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');

const SELECT = `
  SELECT c.*, u.username AS contributor_username, r.username AS reviewer_username
  FROM coref_contributions c
  LEFT JOIN users u ON u.id = c.user_id
  LEFT JOIN users r ON r.id = c.reviewed_by
`;

/** A stored row in the shape the routes answer with. */
const present = (row) => row && ({
  id: row.id,
  userId: row.user_id,
  contributorUsername: row.contributor_username || null,
  worldId: row.world_id,
  passage: row.passage,
  modelId: row.model_id,
  modelVersion: row.model_version,
  clusters: JSON.parse(row.clusters),
  clusterEntities: JSON.parse(row.cluster_entities),
  corrections: JSON.parse(row.corrections),
  state: row.state,
  reviewedBy: row.reviewed_by,
  reviewerUsername: row.reviewer_username || null,
  reviewedAt: row.reviewed_at,
  createdAt: row.created_at
});

const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Contributed Character Mentions corrections and the staff queue that reviews them.
 */
const CorefContribution = {
  /**
   * Store a contribution. A pending row for the same account, world and passage is replaced (Character Mentions spec Q35).
   *
   * @param {string} userId - The contributor
   * @param {Object} value - The normalized submission from `readSubmission`
   * @returns {{contribution: Object, replaced: boolean}}
   */
  submit: db.transaction((userId, value) => {
    const passageSha = sha256(value.passage);
    const fields = {
      userId,
      worldId: value.worldId,
      passage: value.passage,
      passageSha,
      modelId: value.modelId,
      modelVersion: value.modelVersion,
      clusters: JSON.stringify(value.clusters),
      clusterEntities: JSON.stringify(value.clusterEntities),
      corrections: JSON.stringify(value.corrections),
      createdAt: new Date().toISOString()
    };

    const pending = db.prepare(`
      SELECT id FROM coref_contributions
      WHERE user_id = ? AND world_id = ? AND passage_sha256 = ? AND state = 'pending'
    `).get(userId, value.worldId, passageSha);

    if (pending) {
      db.prepare(`
        UPDATE coref_contributions
        SET passage = @passage, model_id = @modelId, model_version = @modelVersion, clusters = @clusters,
            cluster_entities = @clusterEntities, corrections = @corrections, created_at = @createdAt
        WHERE id = @id
      `).run({ ...fields, id: pending.id });
      return { contribution: CorefContribution.findById(pending.id), replaced: true };
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO coref_contributions (
        id, user_id, world_id, passage, passage_sha256, model_id, model_version,
        clusters, cluster_entities, corrections, state, created_at
      )
      VALUES (@id, @userId, @worldId, @passage, @passageSha, @modelId, @modelVersion,
              @clusters, @clusterEntities, @corrections, 'pending', @createdAt)
    `).run({ ...fields, id });
    return { contribution: CorefContribution.findById(id), replaced: false };
  }),

  /** @returns {Object|null} One contribution */
  findById: (id) => present(db.prepare(`${SELECT} WHERE c.id = ?`).get(id)),

  /** @returns {Object[]} Pending contributions, oldest first */
  pending: ({ limit }) => db.prepare(`${SELECT} WHERE c.state = 'pending' ORDER BY c.created_at ASC, c.id ASC LIMIT ?`)
    .all(limit)
    .map(present),

  /** @returns {number} How many contributions wait for review */
  pendingCount: () => db.prepare("SELECT COUNT(*) AS n FROM coref_contributions WHERE state = 'pending'").get().n,

  /**
   * Accept or reject a pending contribution.
   *
   * @returns {Object|null} The reviewed contribution, or null when no pending row has that id
   */
  review: (id, state, reviewerId) => {
    const changed = db.prepare(`
      UPDATE coref_contributions SET state = ?, reviewed_by = ?, reviewed_at = ?
      WHERE id = ? AND state = 'pending'
    `).run(state, reviewerId, new Date().toISOString(), id).changes;
    return changed ? CorefContribution.findById(id) : null;
  },

  /** @returns {Object[]} Accepted contributions, oldest first */
  accepted: () => db.prepare(`${SELECT} WHERE c.state = 'accepted' ORDER BY c.created_at ASC, c.id ASC`)
    .all()
    .map(present),

  /**
   * Drop every contribution of an account except the accepted ones (Character Mentions spec Q15, Q37).
   *
   * @returns {number} How many rows went
   */
  dropUnaccepted: (userId) => db.prepare("DELETE FROM coref_contributions WHERE user_id = ? AND state <> 'accepted'")
    .run(userId).changes
};

module.exports = CorefContribution;
