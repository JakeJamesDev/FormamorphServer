const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

/**
 * Listing Changelog model — the Changelog Entries on one published listing.
 *
 * Nothing here touches `worlds`. That is the whole point of the table: a changelog write is metadata, so
 * it must not move the listing's `updated_at` and resurface it as freshly updated (the spoiler toggle and
 * the contest withdrawal leave it alone for the same reason).
 */
const Changelog = {
  /**
   * Find one entry by ID.
   *
   * @param {string} id - Entry ID
   * @returns {Object|undefined} The row, or undefined
   */
  findById: (id) => db.prepare('SELECT * FROM world_changelog WHERE id = ?').get(id),

  /**
   * Every entry on a listing, newest first.
   *
   * Sorted by the author's own date, with `created_at` breaking its ties — two entries dated the same day
   * keep the order they were written in, rather than whatever order the rows come back in.
   *
   * @param {string} worldId - World ID
   * @returns {Array<Object>} The entries
   */
  getByWorldId: (worldId) => db
    .prepare(`
      SELECT * FROM world_changelog
      WHERE world_id = ?
      ORDER BY entry_date DESC, created_at DESC
    `)
    .all(worldId),

  /**
   * How many entries a listing already carries, for the per-listing cap.
   *
   * @param {string} worldId - World ID
   * @returns {number} The count
   */
  countFor: (worldId) => db
    .prepare('SELECT COUNT(*) AS count FROM world_changelog WHERE world_id = ?')
    .get(worldId).count,

  /**
   * Write a new entry.
   *
   * @param {Object} entry - `{ world_id, title, body, entry_date }`
   * @returns {Object} The stored row
   */
  create: (entry) => {
    const id = entry.id || uuidv4();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO world_changelog (id, world_id, title, body, entry_date, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, entry.world_id, entry.title, entry.body, entry.entry_date, now, now);

    return Changelog.findById(id);
  },

  /**
   * Rewrite an entry. All three authored fields are replaced together — the popup edits the whole entry,
   * so a partial update has no caller and would only be a way for one to arrive half-applied.
   *
   * @param {string} id - Entry ID
   * @param {Object} entry - `{ title, body, entry_date }`
   * @returns {Object|undefined} The updated row
   */
  update: (id, entry) => {
    db.prepare(`
      UPDATE world_changelog
      SET title = ?, body = ?, entry_date = ?, updated_at = ?
      WHERE id = ?
    `).run(entry.title, entry.body, entry.entry_date, new Date().toISOString(), id);

    return Changelog.findById(id);
  },

  /**
   * Remove an entry.
   *
   * @param {string} id - Entry ID
   * @returns {boolean} Whether a row went
   */
  delete: (id) => db.prepare('DELETE FROM world_changelog WHERE id = ?').run(id).changes > 0
};

module.exports = Changelog;
