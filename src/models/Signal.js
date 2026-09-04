const db = require('../config/db');

/**
 * What an account did. One value per action a ring of accounts has to repeat to be worth anything, so the
 * table holds the moments that link accounts and nothing else — reading the catalog leaves no trace.
 */
const EVENTS = ['signup', 'login', 'like', 'publish', 'comment', 'follow'];

/** How long a Signal is kept. The privacy policy states this number; changing it changes the promise. */
const RETENTION_DAYS = 90;

/**
 * Append-only record of where an account acted from, in a form nobody can read an address back out of.
 *
 * Rows arrive and expire and are never edited. Nothing here decides anything: a shared Signal is evidence
 * for a person to weigh, never a hold, a block or a score. That is a design decision, not an omission.
 *
 * @see utils/recordSignal for how a row is written, and utils/sweepSignals for how it expires
 */
const Signal = {
  EVENTS,
  RETENTION_DAYS,

  /**
   * Write one row.
   *
   * @param {Object} signal - `{ userId, event, addressHash, browserFamily }`
   * @returns {Object} The stored row
   */
  create: ({ userId, event, addressHash, browserFamily }) => {
    const info = db.prepare(`
      INSERT INTO signals (user_id, event, address_hash, browser_family, created_at)
      VALUES (@userId, @event, @addressHash, @browserFamily, @createdAt)
    `).run({ userId, event, addressHash, browserFamily, createdAt: new Date().toISOString() });

    return Signal.findById(info.lastInsertRowid);
  },

  /**
   * Read one row.
   * @param {number} id - Row ID
   * @returns {Object|undefined} The row, or undefined when there is no such row
   */
  findById: (id) => db.prepare('SELECT * FROM signals WHERE id = ?').get(id),

  /**
   * Drop every row older than a cutoff.
   *
   * @param {string} before - ISO instant; rows stamped before it go
   * @returns {number} How many rows were deleted
   */
  deleteBefore: (before) => db.prepare('DELETE FROM signals WHERE created_at < ?').run(before).changes
};

module.exports = Signal;
