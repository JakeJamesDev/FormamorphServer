const db = require('../config/db');

/**
 * A mark one Install left on a listing.
 *
 * The other half of the number a listing shows. An account Like says an account was glad it downloaded
 * something; this says a copy of the app was, which is the same gladness from somebody who has not made
 * an account. Both are revocable, and the room is shown their sum — see `World.likeCount`.
 *
 * Rows are addressed by the Install alone. The hash beside them is what the cap counts and what the
 * sweep empties at ninety days; the browser family is for the staff audit, and nothing here reads it.
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
   * How many other Installs have marked this listing from the same address.
   *
   * The Install asking is left out of its own count, so a repeat press and a press after a clear are
   * always allowed: the question is how many places under the cap the rest have taken, not how many
   * rows exist.
   *
   * Blanked rows fall out on their own. A hash the sweep has emptied matches no address, so a mark past
   * its retention stops holding a place while the like itself stays and stays counted.
   *
   * @param {string} worldId - The listing
   * @param {string} addressHash - The salted hash of the address pressing now
   * @param {string} installId - The Install pressing now, excluded
   * @returns {number} How many other Installs share the address on this listing
   */
  countFromAddress: (worldId, addressHash, installId) => db.prepare(`
    SELECT COUNT(*) AS n FROM anonymous_likes
    WHERE world_id = ? AND address_hash = ? AND install_id <> ?
  `).get(worldId, addressHash, installId).n,

  /**
   * Empty the address hash on every mark older than the cutoff, and say how many were emptied.
   *
   * The like survives; only where it came from goes. The privacy text promises the address is kept for
   * the retention period and no longer, and the number a listing shows is not the operator's to quietly
   * reduce at ninety days, so the two are separated here rather than by deleting the row.
   *
   * Rows already emptied are skipped, so the count is what this run changed and a second run over the
   * same rows reports nothing.
   *
   * @param {string} cutoff - The oldest instant still inside retention, as an ISO string
   * @returns {number} How many marks lost their hash
   */
  blankHashesBefore: (cutoff) => db.prepare(`
    UPDATE anonymous_likes SET address_hash = '' WHERE created_at < ? AND address_hash <> ''
  `).run(cutoff).changes,

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
  }
};

module.exports = AnonymousLike;
