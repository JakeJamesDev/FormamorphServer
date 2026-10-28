const crypto = require('crypto');
const db = require('../config/db');

/**
 * The watermark number of each account: what `utils/watermark` writes into that account's copies, and
 * the way back from a number read out of a leak to the account it names.
 */

const findOrMake = db.transaction((userId) => {
  const existing = db.prepare('SELECT mark FROM watermark_marks WHERE user_id = ?').get(userId);
  if (existing) return existing.mark;

  const taken = db.prepare('SELECT 1 FROM watermark_marks WHERE mark = ?');
  let mark;
  do mark = crypto.randomBytes(4).readUInt32BE(0); while (taken.get(mark));

  db.prepare('INSERT INTO watermark_marks (user_id, mark, created_at) VALUES (?, ?, ?)')
    .run(userId, mark, new Date().toISOString());
  return mark;
});

const WatermarkMark = {
  /**
   * The account's mark number, made on first use and the same on every later call.
   *
   * @param {string} userId - The account
   * @returns {number} A 32-bit unsigned integer
   */
  markFor: (userId) => findOrMake(userId),

  /**
   * @param {number} mark - A number `read` returned
   * @returns {Object|null} `{ id, username }`, or null when no account holds it
   */
  accountFor: (mark) => db.prepare(`
    SELECT users.id, users.username FROM watermark_marks
    JOIN users ON users.id = watermark_marks.user_id
    WHERE watermark_marks.mark = ?
  `).get(mark) || null
};

module.exports = WatermarkMark;
