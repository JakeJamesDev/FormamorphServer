const db = require('../config/db');
const World = require('./World');

/**
 * What a world requires: the source listings its author declared necessary.
 *
 * The world author is the only authority here. A component author cannot make their work required by
 * anyone's world, and nothing about ownership makes a source required — see `Compatibility` for the
 * association a component author does write.
 */
const Dependency = {
  /**
   * The source ids a world requires, in the order they were declared.
   * @param {string} worldId - World ID
   * @returns {string[]} Source listing IDs
   */
  sourceIdsFor: (worldId) => db
    .prepare('SELECT source_id FROM listing_dependencies WHERE world_id = ? ORDER BY created_at, rowid')
    .all(worldId)
    .map((row) => row.source_id),

  /**
   * Whether a world requires a source.
   * @param {string} worldId - World ID
   * @param {string} sourceId - Source listing ID
   * @returns {boolean} True when the declaration exists
   */
  has: (worldId, sourceId) => Boolean(
    db.prepare('SELECT 1 AS found FROM listing_dependencies WHERE world_id = ? AND source_id = ?').get(worldId, sourceId)
  ),

  /**
   * Make the declared set exactly `sourceIds`. Rows already present keep their date, so the order a
   * client sees is the order the author built the list in.
   *
   * @param {string} worldId - World ID
   * @param {string[]} sourceIds - The whole set to hold from now on
   * @returns {boolean} Whether anything was added or removed
   */
  replaceFor: db.transaction((worldId, sourceIds) => {
    const wanted = new Set(sourceIds);
    const existing = new Set(Dependency.sourceIdsFor(worldId));
    const now = new Date().toISOString();
    let changed = false;

    const remove = db.prepare('DELETE FROM listing_dependencies WHERE world_id = ? AND source_id = ?');
    for (const sourceId of existing) {
      if (wanted.has(sourceId)) continue;
      remove.run(worldId, sourceId);
      changed = true;
    }

    const insert = db.prepare('INSERT INTO listing_dependencies (world_id, source_id, created_at) VALUES (?, ?, ?)');
    for (const sourceId of sourceIds) {
      if (existing.has(sourceId)) continue;
      insert.run(worldId, sourceId, now);
      changed = true;
    }

    return changed;
  }),

  /**
   * A world's required dependencies as a client resolves them: each source as this viewer may receive it,
   * or the bare id and `not_found` when they may not.
   *
   * `not_found` covers a deleted source, a quarantined one, and any id that never existed, on purpose: the
   * three are indistinguishable to the room everywhere else, and a dependency answer that told them apart
   * would be the one place a hidden listing's existence could be probed. Unlisted is the exception this
   * path exists for — a source hidden from discovery is served here to anyone who can read the world.
   *
   * @param {string} worldId - World ID
   * @param {Object} [viewer] - The signed-in user, or null
   * @returns {Array<Object>} `{ id, status: 'ok', listing }` or `{ id, status: 'not_found' }` per source
   */
  resolveFor: (worldId, viewer = null) => Dependency.sourceIdsFor(worldId).map((id) => {
    const source = World.findById(id);
    if (!World.isDependencyVisibleTo(source, viewer)) return { id, status: 'not_found' };

    const listing = World.findByIdWithAuthor(id, viewer);
    delete listing.content_file;

    return { id, status: 'ok', listing };
  })
};

module.exports = Dependency;
