const db = require('../config/db');
const { DEFAULT_REVIEW_STATE } = require('../config/relationships');

/**
 * What a component is offered for, and what each world's author said about the offer.
 *
 * Two writers with one row between them. The component author writes the association and nothing else;
 * the world author writes the review state and nothing else. Neither can make the component required —
 * that is `Dependency`, and only the world author writes that.
 */
const Compatibility = {
  /**
   * One association.
   * @param {string} componentId - Component listing ID
   * @param {string} worldId - World ID
   * @returns {Object|undefined} The row
   */
  find: (componentId, worldId) => db
    .prepare('SELECT * FROM listing_compatibility WHERE component_id = ? AND world_id = ?')
    .get(componentId, worldId),

  /**
   * The worlds a component is offered for, each with what its author said, and enough of the world row
   * to decide whether this viewer may know it exists.
   *
   * @param {string} componentId - Component listing ID
   * @returns {Array<Object>} Association rows joined to the world's visibility columns and its author
   */
  worldsFor: (componentId) => db.prepare(`
    SELECT c.world_id, c.review_state, c.reviewed_revision, c.reviewed_at, c.created_at,
      w.name, w.author_id, w.quarantined_at, w.visibility, w.revision, w.updated_at,
      u.username AS author_username
    FROM listing_compatibility c
    JOIN worlds w ON w.id = c.world_id
    JOIN users u ON u.id = w.author_id
    WHERE c.component_id = ?
    ORDER BY c.created_at, c.rowid
  `).all(componentId),

  /**
   * The components offered for a world, oldest offer first, with the component's current revision so a
   * caller can say whether it changed since the world author last looked.
   *
   * @param {string} worldId - World ID
   * @returns {Array<Object>} Association rows with the component's revision beside them
   */
  componentsFor: (worldId) => db.prepare(`
    SELECT c.component_id, c.review_state, c.reviewed_revision, c.reviewed_at, c.created_at,
      w.revision AS component_revision
    FROM listing_compatibility c
    JOIN worlds w ON w.id = c.component_id
    WHERE c.world_id = ?
    ORDER BY c.created_at, c.rowid
  `).all(worldId),

  /**
   * Make a component's offered set exactly `worldIds`. An association that stays keeps the world author's
   * answer: republishing a component must not reset a review the world author already gave.
   *
   * @param {string} componentId - Component listing ID
   * @param {string[]} worldIds - The whole set to hold from now on
   * @returns {boolean} Whether anything was added or removed
   */
  replaceFor: db.transaction((componentId, worldIds) => {
    const wanted = new Set(worldIds);
    const existing = new Set(
      db.prepare('SELECT world_id FROM listing_compatibility WHERE component_id = ?').all(componentId)
        .map((row) => row.world_id)
    );
    const now = new Date().toISOString();
    let changed = false;

    const remove = db.prepare('DELETE FROM listing_compatibility WHERE component_id = ? AND world_id = ?');
    for (const worldId of existing) {
      if (wanted.has(worldId)) continue;
      remove.run(componentId, worldId);
      changed = true;
    }

    const insert = db.prepare(`
      INSERT INTO listing_compatibility (component_id, world_id, review_state, created_at) VALUES (?, ?, ?, ?)
    `);
    for (const worldId of worldIds) {
      if (existing.has(worldId)) continue;
      insert.run(componentId, worldId, DEFAULT_REVIEW_STATE, now);
      changed = true;
    }

    return changed;
  }),

  /**
   * Record the world author's answer, and which revision of the component it answered. Writing the same
   * state again is how "mark reviewed" works: the decision stands and the revision catches up.
   *
   * @param {string} componentId - Component listing ID
   * @param {string} worldId - World ID
   * @param {string} reviewState - One of `REVIEW_STATES`
   * @param {number} componentRevision - The component's revision as reviewed
   * @returns {Object|undefined} The updated row
   */
  review: (componentId, worldId, reviewState, componentRevision) => {
    db.prepare(`
      UPDATE listing_compatibility
      SET review_state = ?, reviewed_revision = ?, reviewed_at = ?
      WHERE component_id = ? AND world_id = ?
    `).run(reviewState, componentRevision, new Date().toISOString(), componentId, worldId);

    return Compatibility.find(componentId, worldId);
  }
};

module.exports = Compatibility;
