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

/** The rows that count against the bounce rate and the complaint rate. */
const HARD_BOUNCE = "status = 'bounced' AND bounce_type = 'hard'";
const COMPLAINED = "status = 'complained'";

const countWhere = (condition) => `COALESCE(SUM(${condition}), 0)`;

/** The counts each day of the mail report holds. */
const DAY_COUNTS = ['sent', 'delivered', 'delayed', 'hardBounced', 'softBounced', 'complained'];

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
   * One account's mails, newest first, without the SES message id.
   *
   * @param {string} userId - User ID
   * @returns {Array<Object>} `{ kind, status, sentAt, statusAt }` per mail, plus `bounceType` on a bounced one
   */
  forUser: (userId) => db.prepare(`
    SELECT kind, status, bounce_type AS bounceType, sent_at AS sentAt, status_at AS statusAt
    FROM mail_log WHERE user_id = ? ORDER BY sent_at DESC, rowid DESC
  `).all(userId).map(({ bounceType, ...mail }) => (mail.status === STATUSES.BOUNCED ? { ...mail, bounceType } : mail)),

  DAY_COUNTS,

  /**
   * Each UTC send day's counts since an instant: every mail sent, then each row by its current status.
   * Days without mail are absent.
   *
   * @param {string} since - An ISO instant
   * @returns {Array<Object>} One row per day: `day` and each of `DAY_COUNTS`
   */
  daysSince: (since) => db.prepare(`
    SELECT substr(sent_at, 1, 10) AS day,
           COUNT(*) AS sent,
           ${countWhere("status = 'delivered'")} AS delivered,
           ${countWhere("status = 'delayed'")} AS delayed,
           ${countWhere(HARD_BOUNCE)} AS hardBounced,
           ${countWhere("status = 'bounced' AND bounce_type = 'soft'")} AS softBounced,
           ${countWhere(COMPLAINED)} AS complained
    FROM mail_log WHERE sent_at >= ? GROUP BY day
  `).all(since),

  /**
   * Mails sent since an instant, and how many of them hard-bounced or drew a complaint.
   *
   * @param {string} since - An ISO instant
   * @returns {{ volume: number, hardBounces: number, complaints: number }} The counts
   */
  rateCounts: (since) => db.prepare(`
    SELECT COUNT(*) AS volume, ${countWhere(HARD_BOUNCE)} AS hardBounces, ${countWhere(COMPLAINED)} AS complaints
    FROM mail_log WHERE sent_at >= ?
  `).get(since),

  /**
   * Delete every row sent before an instant.
   *
   * @param {string} cutoff - An ISO instant
   * @returns {number} Rows deleted
   */
  deleteBefore: (cutoff) => db.prepare('DELETE FROM mail_log WHERE sent_at < ?').run(cutoff).changes
};

module.exports = MailLog;
