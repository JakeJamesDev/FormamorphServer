const db = require('../config/db');
const { DAY_MS } = require('../config/time');

/**
 * What an account did. One value per action a ring of accounts has to repeat to be worth anything, so the
 * table holds the moments that link accounts and nothing else — reading the catalog leaves no trace.
 */
const EVENTS = ['signup', 'login', 'like', 'publish', 'comment', 'follow'];

/** How long a Signal is kept. The privacy policy states this number; changing it changes the promise. */
const RETENTION_DAYS = 90;

/**
 * How many matched moments each side of a link carries.
 *
 * Two accounts that share an address for three months have hundreds of them, and a staff member reads
 * the first few and decides. The true count travels beside the rows, so a capped list still says how
 * much is behind it.
 */
const MATCH_EVENT_LIMIT = 20;

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
  MATCH_EVENT_LIMIT,

  /**
   * The oldest instant still inside retention.
   *
   * One place, because the sweeper and the staff views have to agree: a row the sweeper would delete
   * must not still be linking two accounts on a screen.
   *
   * @param {string} [now] - The instant to measure back from, for tests
   * @returns {string} An ISO instant
   */
  cutoff: (now = undefined) =>
    new Date((now ? new Date(now).getTime() : Date.now()) - RETENTION_DAYS * DAY_MS).toISOString(),

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
   * Every other account that acted from one of this account's addresses inside retention.
   *
   * The one question this table exists to answer. Both sides come back, because a link is only worth
   * reading as a pair of stories: four accounts that each signed up minutes apart from one address is a
   * ring, and one account that logs in from a cafe another regular also uses is a coincidence. Which of
   * those it is stays a person's judgment — nothing here decides anything.
   *
   * Matches are cut at the retention edge rather than left to the sweeper, which runs hourly: a row an
   * hour past ninety days must not still be linking two accounts on a staff screen.
   *
   * @param {string} userId - Whose links to read
   * @returns {Array<Object>} One entry per other account, the newest match first
   */
  linkedAccounts: (userId) => {
    const cutoff = Signal.cutoff();

    // Both sides in one read: the subject's own rows come back alongside the matches, so the moments
    // that made each link can be paired up without asking again per account.
    const rows = db.prepare(`
      SELECT s.user_id, s.event, s.created_at, s.address_hash, s.browser_family,
             u.username, u.status, u.created_at AS account_created_at
      FROM signals s
      JOIN users u ON u.id = s.user_id
      WHERE s.created_at >= @cutoff
        AND s.address_hash IN (
          SELECT address_hash FROM signals WHERE user_id = @userId AND created_at >= @cutoff
        )
      ORDER BY s.created_at DESC, s.id DESC
    `).all({ userId, cutoff });

    const moment = (row) => ({ event: row.event, at: row.created_at, browserFamily: row.browser_family });
    const mine = rows.filter((row) => row.user_id === userId);

    // Newest first from the query, so first-seen order is newest-match-first and the list needs no sort.
    const others = new Map();
    for (const row of rows) {
      if (row.user_id === userId) continue;

      let entry = others.get(row.user_id);
      if (!entry) {
        entry = {
          id: row.user_id,
          username: row.username,
          status: row.status,
          createdAt: row.account_created_at,
          hashes: new Set(),
          events: []
        };
        others.set(row.user_id, entry);
      }
      entry.hashes.add(row.address_hash);
      entry.events.push(row);
    }

    return [...others.values()].map((entry) => {
      // Narrowed to the addresses this pair actually shares. The subject may have acted from three
      // places; only the one they met on is evidence about this account.
      const shared = mine.filter((row) => entry.hashes.has(row.address_hash));

      return {
        id: entry.id,
        username: entry.username,
        status: entry.status,
        createdAt: entry.createdAt,
        events: entry.events.slice(0, MATCH_EVENT_LIMIT).map(moment),
        eventsTotal: entry.events.length,
        subjectEvents: shared.slice(0, MATCH_EVENT_LIMIT).map(moment),
        subjectEventsTotal: shared.length
      };
    });
  },

  /**
   * Drop every row older than a cutoff.
   *
   * @param {string} before - ISO instant; rows stamped before it go
   * @returns {number} How many rows were deleted
   */
  deleteBefore: (before) => db.prepare('DELETE FROM signals WHERE created_at < ?').run(before).changes
};

module.exports = Signal;
