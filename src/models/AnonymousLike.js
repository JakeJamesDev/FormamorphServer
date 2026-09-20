const db = require('../config/db');

/**
 * A mark one Install left on a listing.
 *
 * The other half of the number a listing shows. An account Like says an account was glad it downloaded
 * something; this says a copy of the app was, which is the same gladness from somebody who has not made
 * an account. Both are revocable, and the room is shown their sum — see `World.likeCount`.
 *
 * Rows are addressed by the Install alone. The hash and the browser family beside them are for the cap
 * and for the staff audit, and nothing here reads them.
 *
 * @see config/anonymousLikes for what an Install is and how one arrives
 */
const AnonymousLike = {
  /**
   * Add or remove this Install's mark. Idempotent in both directions.
   *
   * The hash and the browser family are written on the way in and left alone by a repeat press, so a
   * second press from a new address does not rewrite where the first one came from.
   *
   * @param {string} worldId - The listing
   * @param {string} installId - The Install
   * @param {boolean} liked - Whether the mark should be on it
   * @param {Object} where - `{ addressHash, browserFamily }`, as `recordSignal` derives them
   */
  set: (worldId, installId, liked, { addressHash, browserFamily } = {}) => {
    if (!liked) {
      AnonymousLike.clear(worldId, installId);
      return;
    }

    db.prepare(`
      INSERT INTO anonymous_likes (world_id, install_id, address_hash, browser_family, created_at)
      VALUES (@worldId, @installId, @addressHash, @browserFamily, @createdAt)
      ON CONFLICT(world_id, install_id) DO NOTHING
    `).run({
      worldId,
      installId,
      addressHash,
      browserFamily,
      createdAt: new Date().toISOString()
    });
  },

  /**
   * Take this Install's mark off a listing.
   *
   * @param {string} worldId - The listing
   * @param {string} installId - The Install
   * @returns {boolean} Whether a mark was there to remove
   */
  clear: (worldId, installId) =>
    db.prepare('DELETE FROM anonymous_likes WHERE world_id = ? AND install_id = ?')
      .run(worldId, installId).changes > 0,

  /**
   * Whether this Install has marked a listing.
   *
   * @param {string} worldId - The listing
   * @param {string} installId - The Install
   * @returns {boolean} True when its mark is on it
   */
  has: (worldId, installId) => Boolean(
    db.prepare('SELECT 1 AS found FROM anonymous_likes WHERE world_id = ? AND install_id = ?')
      .get(worldId, installId)
  ),

  /**
   * Which of the given listings this Install has marked, so a page of cards can fill every heart in
   * without a query per card. The account side's `World.likedAmong` does the same job for a reader.
   *
   * @param {Array<string>} ids - The listings on the page
   * @param {string} installId - The Install
   * @returns {Set<string>} The listings it has marked
   */
  likedAmong: (ids, installId) => {
    if (ids.length === 0) return new Set();

    const rows = db.prepare(`
      SELECT world_id FROM anonymous_likes
      WHERE install_id = ? AND world_id IN (${ids.map(() => '?').join(',')})
    `).all(installId, ...ids);

    return new Set(rows.map((row) => row.world_id));
  },

  /**
   * How many Installs have marked a listing. The account side's count is `World.accountLikeCount`, and
   * the room is shown the two added together.
   *
   * @param {string} worldId - The listing
   * @returns {number} The count
   */
  countFor: (worldId) =>
    db.prepare('SELECT COUNT(*) AS count FROM anonymous_likes WHERE world_id = ?').get(worldId).count
};

module.exports = AnonymousLike;
