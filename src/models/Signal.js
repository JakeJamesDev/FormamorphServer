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
 * @see utils/recordSignal for how a row is written, and utils/sweepRetention for how it expires
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
   * Which of a set of nodes acted from the same address as each other, and which of them acted from one
   * more account's address.
   *
   * The likes audit's question, asked of a listing's Likers with its author as the account to check them
   * against. Grouping is transitive: a ring that moves between two addresses is one person twice over,
   * not two coincidences, so accounts joined through a third are joined to each other.
   *
   * An account is never linked to itself. An author who liked their own listing is the author, and
   * marking their row would say something the list already says by having their name in it.
   *
   * Cut at the retention edge for the reason `linkedAccounts` is: the sweeper runs hourly, and a row it
   * would delete must not still be grouping accounts on a staff screen.
   *
   * A node need not be an account. `extraNodes` carries the ones that are not — an Anonymous Like has
   * no account behind it, only the address it came from — and each groups and links the way an account
   * does. The caller names them, and must name them something no account id can be. A node with no
   * address shares nothing, so it comes back listed and in no group.
   *
   * @param {Array<string>} userIds - The accounts to group against each other
   * @param {string} [againstUserId] - One more account each node is separately checked against
   * @param {Array<Object>} [extraNodes] - `{ id, hash }` for each node that is not an account
   * @returns {Object} `{ groupOf, linkedToTarget }` — a Map from node to its group number, holding only
   *   nodes that are in a group of two or more, and a Set of the nodes sharing an address with
   *   `againstUserId`
   */
  sharedAddressGroups: (userIds, againstUserId = null, extraNodes = []) => {
    const ids = [...new Set(userIds)];
    // Accounts first, then the rest: a group takes its number from where its first node falls here.
    const nodes = [...ids, ...extraNodes.map((node) => node.id)];
    const empty = { groupOf: new Map(), linkedToTarget: new Set() };
    if (nodes.length === 0) return empty;

    const wanted = againstUserId && !ids.includes(againstUserId) ? [...ids, againstUserId] : ids;
    const rows = wanted.length === 0 ? [] : db.prepare(`
      SELECT DISTINCT user_id, address_hash
      FROM signals
      WHERE created_at >= ? AND user_id IN (${wanted.map(() => '?').join(',')})
    `).all(Signal.cutoff(), ...wanted);

    const hashesOf = new Map();
    const sharing = new Map();
    const actedFrom = (nodeId, hash) => {
      if (!hashesOf.has(nodeId)) hashesOf.set(nodeId, new Set());
      hashesOf.get(nodeId).add(hash);

      if (!sharing.has(hash)) sharing.set(hash, []);
      sharing.get(hash).push(nodeId);
    };

    for (const { user_id: userId, address_hash: hash } of rows) actedFrom(userId, hash);
    for (const node of extraNodes) if (node.hash) actedFrom(node.id, node.hash);

    const targetHashes = againstUserId ? hashesOf.get(againstUserId) ?? new Set() : new Set();
    const linkedToTarget = new Set(nodes.filter((id) =>
      id !== againstUserId && [...(hashesOf.get(id) ?? [])].some((hash) => targetHashes.has(hash))));

    // Union-find over the nodes asked about, so sharing reaches through a third node.
    const parent = new Map(nodes.map((id) => [id, id]));
    const find = (id) => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      while (parent.get(id) !== root) {
        const next = parent.get(id);
        parent.set(id, root);
        id = next;
      }
      return root;
    };
    for (const members of sharing.values()) {
      const here = members.filter((id) => parent.has(id));
      for (const id of here.slice(1)) {
        const [left, right] = [find(here[0]), find(id)];
        if (left !== right) parent.set(left, right);
      }
    }

    const size = new Map();
    for (const id of nodes) {
      const root = find(id);
      size.set(root, (size.get(root) ?? 0) + 1);
    }

    // Numbered by where a group's first node falls in the order asked about, so the numbers read down
    // the screen the list is drawn in rather than out of whatever order the rows came back in.
    const groupOf = new Map();
    const numbers = new Map();
    for (const id of nodes) {
      const root = find(id);
      if ((size.get(root) ?? 0) < 2) continue;
      if (!numbers.has(root)) numbers.set(root, numbers.size + 1);
      groupOf.set(id, numbers.get(root));
    }

    return { groupOf, linkedToTarget };
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
