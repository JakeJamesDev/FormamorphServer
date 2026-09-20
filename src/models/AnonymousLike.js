const db = require('../config/db');
const { ADDRESS_CAP } = require('../config/anonymousLikes');
const { addressKeyFor } = require('../utils/addressKey');

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
   * Whether this address has a place left on this listing.
   *
   * The rule lives with the rows it counts rather than with the route that refuses. The route turns a
   * no into a status and a code, and that is all of it the route decides.
   *
   * Only other Installs are counted, so a repeat press and a press after a clear are always allowed.
   * The question is how many places the rest have taken, not how many rows exist, and an Install must
   * never be what stands in its own way.
   *
   * Blanked rows fall out on their own. A hash the sweep has emptied matches no address, so a mark past
   * its retention stops holding a place while the like itself stays and stays counted.
   *
   * @param {string} worldId - The listing
   * @param {string} addressHash - The salted hash of the address pressing now
   * @param {string} installId - The Install pressing now, which never counts against itself
   * @returns {boolean} Whether a mark from this address may be added
   */
  addressHasRoom: (worldId, addressHash, installId) => db.prepare(`
    SELECT COUNT(*) AS n FROM anonymous_likes
    WHERE world_id = ? AND address_hash = ? AND install_id <> ?
  `).get(worldId, addressHash, installId).n < ADDRESS_CAP,

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
   * How many marks a listing holds.
   *
   * The staff number. `World.likeCount` answers what the room sees, which is this added to the account
   * Likes; this is the half with no account behind it, and the half the removal routes act on.
   *
   * @param {string} worldId - The listing
   * @returns {number} The count
   */
  countFor: (worldId) =>
    db.prepare('SELECT COUNT(*) AS count FROM anonymous_likes WHERE world_id = ?').get(worldId).count,

  /**
   * A listing's marks as the staff audit reads them, newest first.
   *
   * The Install id comes back because the grouping needs one name per row to work in. Keeping it out of
   * what the audit sends is the caller's job: it is the one identifier here that follows a person from
   * listing to listing, and staff have no use for it.
   *
   * @param {string} worldId - The listing
   * @param {number} limit - Row ceiling, the same one the account list uses
   * @returns {Array<Object>} Each mark's `install_id`, `address_hash`, `browser_family`, `created_at`
   */
  auditRows: (worldId, limit) => db.prepare(`
    SELECT install_id, address_hash, browser_family, created_at
    FROM anonymous_likes
    WHERE world_id = ?
    ORDER BY created_at DESC, install_id DESC
    LIMIT ?
  `).all(worldId, limit),

  /**
   * Take every mark from one address off a listing, by the name staff have for that address.
   *
   * The key is one way, so there is nothing to look up: the listing's own hashes are digested again and
   * the one that matches is the address. Blanked hashes never enter the search — they name no address,
   * and reading the empty string as one would make the key for a swept mark clear every other swept mark
   * on the listing.
   *
   * A key that matches nothing removes nothing. A group another staff member removed a moment ago is
   * gone rather than missing, and the caller's own count says which.
   *
   * @param {string} worldId - The listing
   * @param {string} addressKey - The address as the audit named it, from `utils/addressKey`
   * @returns {number} How many marks went
   */
  removeByAddressKey: (worldId, addressKey) => {
    const hashes = db.prepare(`
      SELECT DISTINCT address_hash FROM anonymous_likes WHERE world_id = ? AND address_hash <> ''
    `).all(worldId).map((row) => row.address_hash);

    const hash = hashes.find((stored) => addressKeyFor(worldId, stored) === addressKey);
    if (!hash) return 0;

    return db.prepare('DELETE FROM anonymous_likes WHERE world_id = ? AND address_hash = ?')
      .run(worldId, hash).changes;
  },

  /**
   * Take every mark off a listing, whatever address it came from.
   *
   * The answer to a flood the address grouping can no longer see. Once the sweep has blanked a mark's
   * hash there is nothing left to name it by, so this is the only way an old one goes.
   *
   * @param {string} worldId - The listing
   * @returns {number} How many marks went
   */
  removeAll: (worldId) =>
    db.prepare('DELETE FROM anonymous_likes WHERE world_id = ?').run(worldId).changes,

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
