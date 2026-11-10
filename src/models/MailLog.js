const db = require('../config/db');
const { DAY_MS } = require('../config/time');

/** The kinds of mail the server sends. */
const KINDS = ['verify', 'reset', 'alert'];

/** How long a row is kept. The privacy policy states this number; changing it changes the promise. */
const RETENTION_DAYS = 90;

/** Every status a row can hold. */
const STATUSES = {
  SENT: 'sent',
  DELAYED: 'delayed',
  DELIVERED: 'delivered',
  BOUNCED: 'bounced',
  COMPLAINED: 'complained'
};

/** Statuses no later event moves, except that a complaint or a late bounce may follow a delivery. */
const FINAL = new Set([STATUSES.DELIVERED, STATUSES.BOUNCED, STATUSES.COMPLAINED]);

/**
 * Whether an event may move a row from one status to another.
 *
 * Events arrive out of order and more than once. A delay never undoes a delivery and a delivery never undoes
 * a bounce. A complaint, or a bounce from a server that accepted the mail first, is never lost.
 *
 * @param {string} from - The stored status
 * @param {string} to - The event's status
 * @returns {boolean} Whether the row moves
 */
const moves = (from, to) => {
  if (from === to) return false;
  if (from === STATUSES.DELIVERED) return to === STATUSES.COMPLAINED || to === STATUSES.BOUNCED;
  return !FINAL.has(from);
};

/**
 * The record of each mail SES accepted. `schema/steps/mailLog` says what a row holds.
 */
const MailLog = {
  KINDS,
  STATUSES,
  RETENTION_DAYS,

  /**
   * The oldest instant still inside retention.
   *
   * @param {string} [now] - The instant to measure back from, for tests
   * @returns {string} An ISO instant
   */
  cutoff: (now = undefined) =>
    new Date((now ? new Date(now).getTime() : Date.now()) - RETENTION_DAYS * DAY_MS).toISOString(),

  /**
   * Write the row for a mail SES just accepted.
   *
   * @param {{ id: string, userId: string|null, kind: string, messageId: string|null }} mail - What was sent
   */
  create: ({ id, userId, kind, messageId }) => {
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO mail_log (id, user_id, kind, message_id, status, sent_at, status_at)
      VALUES (@id, @userId, @kind, @messageId, @status, @now, @now)
    `).run({ id, userId: userId ?? null, kind, messageId: messageId ?? null, status: STATUSES.SENT, now });
  },

  /**
   * One row, or undefined.
   *
   * @param {string} id - The row id, as carried in the mail's tag
   * @returns {Object|undefined} The row
   */
  findById: (id) => db.prepare('SELECT * FROM mail_log WHERE id = ?').get(id),

  /**
   * Move a row to an event's status when the status machine allows it.
   *
   * @param {{ id: string, status: string, bounceType?: string|null, at: string }} event - What SES reported;
   *   `bounceType` is `hard` or `soft` on a bounce and null otherwise
   * @returns {{ row: Object|undefined, moved: boolean }} The row as it now stands, and whether it changed
   */
  applyEvent: db.transaction(({ id, status, bounceType = null, at }) => {
    const row = MailLog.findById(id);
    if (!row || !moves(row.status, status)) return { row, moved: false };

    db.prepare('UPDATE mail_log SET status = ?, bounce_type = ?, status_at = ? WHERE id = ?')
      .run(status, bounceType, at, id);

    return { row: MailLog.findById(id), moved: true };
  }),

  /**
   * Delete every row sent before an instant.
   *
   * @param {string} cutoff - An ISO instant
   * @returns {number} Rows deleted
   */
  deleteBefore: (cutoff) => db.prepare('DELETE FROM mail_log WHERE sent_at < ?').run(cutoff).changes
};

module.exports = MailLog;
