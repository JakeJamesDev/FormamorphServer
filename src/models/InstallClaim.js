const db = require('../config/db');

/**
 * The account an Install belongs to, and the move that made it so.
 *
 * A guest presses hearts, then signs in. Without this the likes they gave would stay behind on the
 * Install and the new account would start empty, and worse, signing out again would be a way to like the
 * same listing a second time. A **Claim** fixes both at once: it moves the Install's Anonymous Likes onto
 * the account, and it records that the two belong together so the guest route can keep following the
 * account's rules afterwards.
 *
 * One row per Install. Signing in as somebody else on the same copy of the app moves the link rather than
 * adding a second one, because the question is whose marks these are now and two answers would be none.
 *
 * @see config/anonymousLikes for what an Install is and how one arrives
 */
const InstallClaim = {
  /**
   * The account that last claimed this Install, as much of it as the guards read.
   *
   * @param {string} installId - The Install
   * @returns {{ id: string, status: string }|null} The account, or null when nobody has claimed it
   */
  accountFor: (installId) => db.prepare(`
    SELECT u.id, u.status FROM install_claims c
    JOIN users u ON u.id = c.user_id
    WHERE c.install_id = ?
  `).get(installId) || null,

  /**
   * Move an Install's Anonymous Likes onto an account and link the two.
   *
   * One transaction, because a half-done Claim is the one state that could lose a like or show a count
   * that never existed. Idempotent: the second run finds no marks to move, moves none, and touches the
   * link again to no effect.
   *
   * Two rules decide what becomes a Like, and both are the account route's own. A listing the account
   * already likes takes nothing, since that is one person counted twice. A listing the account wrote
   * takes nothing either, because nobody may like their own work and signing in must not be a way to.
   *
   * Every mark goes whether it became a Like or not, so a Claim leaves nothing behind to claim again. A
   * mark that became a Like leaves the listing's total where it was. A mark either rule skipped lowers
   * that total by one, which is the point of both rules rather than a cost of them.
   *
   * The Like carries the mark's own `created_at` across and is stamped `claimed_at`, so a liked list
   * reads in the order the person pressed and staff can still see why a new account holds an old like.
   *
   * @param {string} installId - The Install being claimed
   * @param {string} userId - The account claiming it
   * @returns {number} How many Anonymous Likes became account Likes
   */
  claim: db.transaction((installId, userId) => {
    const now = new Date().toISOString();

    const claimed = db.prepare(`
      INSERT INTO world_likes (world_id, user_id, created_at, claimed_at)
      SELECT a.world_id, @userId, a.created_at, @now
      FROM anonymous_likes a
      JOIN worlds w ON w.id = a.world_id
      WHERE a.install_id = @installId AND w.author_id <> @userId
      ON CONFLICT(world_id, user_id) DO NOTHING
    `).run({ installId, userId, now }).changes;

    db.prepare('DELETE FROM anonymous_likes WHERE install_id = ?').run(installId);

    db.prepare(`
      INSERT INTO install_claims (install_id, user_id, created_at) VALUES (@installId, @userId, @now)
      ON CONFLICT(install_id) DO UPDATE SET user_id = @userId, created_at = @now
    `).run({ installId, userId, now });

    return claimed;
  })
};

module.exports = InstallClaim;
