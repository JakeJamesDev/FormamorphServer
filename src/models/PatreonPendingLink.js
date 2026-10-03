const crypto = require('crypto');
const db = require('../config/db');
const { PENDING_LINK_TTL_MS } = require('../config/patreon');

/**
 * A Patreon approval that its account has not confirmed yet.
 *
 * The callback cannot tell who approved, so it parks the approval here and hands the approving browser a
 * one-shot token. The link happens only when that token comes back with the same account's bearer.
 */

const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');

const PatreonPendingLink = {
  /**
   * Park an approval and mint its token. Expired approvals go in the same write.
   *
   * @param {Object} params
   * @param {string} params.userId - The account the state named
   * @param {string} params.patreonUserId - The Patreon user who approved
   * @returns {string} The raw token, which is never stored
   */
  create: ({ userId, patreonUserId }) => {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();

    db.transaction(() => {
      db.prepare('DELETE FROM patreon_pending_links WHERE expires_at <= ?').run(new Date(now).toISOString());
      db.prepare(`
        INSERT INTO patreon_pending_links (token_hash, user_id, patreon_user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        hashOf(token), userId, patreonUserId,
        new Date(now + PENDING_LINK_TTL_MS).toISOString(), new Date(now).toISOString()
      );
    })();

    return token;
  },

  /**
   * Spend a token. The row goes whatever the caller does next, so a token works at most once.
   *
   * @param {*} token - The raw token from the request body
   * @returns {{ userId: string, patreonUserId: string }|null} The approval, or null when the token is
   *   unknown, spent, or expired
   */
  take: (token) => {
    if (typeof token !== 'string' || !token) return null;

    const row = db.prepare(`
      DELETE FROM patreon_pending_links WHERE token_hash = ? RETURNING user_id, patreon_user_id, expires_at
    `).get(hashOf(token));

    if (!row || row.expires_at <= new Date().toISOString()) return null;

    return { userId: row.user_id, patreonUserId: row.patreon_user_id };
  }
};

module.exports = PatreonPendingLink;
