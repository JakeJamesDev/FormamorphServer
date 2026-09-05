const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');
const { tokenExpiry } = require('../config/accountTokens');

/**
 * The one-shot tokens behind a verification or a reset link.
 *
 * Two operations and no more: mint one and hand back the only copy, or spend one. The raw token exists
 * for the length of `issue`'s return and then only in the mail — every row holds a hash, and `consume`
 * hashes what it is given rather than looking anything up by a value a caller could read out of the
 * table. That is the whole reason a leak of `account_tokens` is not a leak of working links.
 */

/** How a token is written down. SHA-256 rather than bcrypt: the input is 32 random bytes, not a password. */
const hashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');

const AccountToken = {
  /**
   * Mint a token for one account and one purpose, retiring whatever it held for that purpose before.
   *
   * Retiring the old one is what makes "resend the mail" safe to offer: two live links to the same door
   * means the older mail still works after the newer one has been used, which is exactly the replay the
   * single-use rule exists to stop. The newest mail is always the one that works.
   *
   * @param {Object} params - The account and what the link is for
   * @param {string} params.userId - Whose link it is
   * @param {string} params.purpose - `VERIFY` or `RESET`, from `config/accountTokens`
   * @returns {string} The raw token, which is never stored and cannot be read back
   */
  issue: ({ userId, purpose }) => {
    const token = crypto.randomBytes(32).toString('base64url');

    db.transaction(() => {
      db.prepare('DELETE FROM account_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);
      db.prepare(`
        INSERT INTO account_tokens (id, user_id, purpose, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(uuidv4(), userId, purpose, hashOf(token), tokenExpiry(purpose), new Date().toISOString());
    })();

    return token;
  },

  /**
   * Spend a token, if it is one and it is still good.
   *
   * The stamp is written in the same statement that matches the row, so two requests carrying one token
   * cannot both find it unconsumed. Everything a caller could get wrong — a token nobody was issued, the
   * wrong door, an expired link, a second use — comes back the same way, because a caller holding a bad
   * token learns nothing from being told which kind of bad it is.
   *
   * @param {Object} params - The token and the door it is being used on
   * @param {string} params.token - The raw token out of the link
   * @param {string} params.purpose - `VERIFY` or `RESET`, from `config/accountTokens`
   * @returns {string|null} The account the token belongs to, or null when it cannot be spent
   */
  consume: ({ token, purpose }) => {
    // A JSON body can carry any shape at all in this field. Anything that is not a token is not one,
    // and hashing it instead would throw out of a route whose whole job is to refuse politely.
    if (typeof token !== 'string' || !token) return null;

    const row = db.prepare(`
      UPDATE account_tokens
      SET consumed_at = @now
      WHERE token_hash = @hash AND purpose = @purpose AND consumed_at IS NULL AND expires_at > @now
      RETURNING user_id
    `).get({ hash: hashOf(token), purpose, now: new Date().toISOString() });

    return row ? row.user_id : null;
  }
};

module.exports = AccountToken;
