const db = require('../config/db');
const { v4: uuidv4 } = require('uuid');

/**
 * What kind of happening a row describes. `contest` adds entries and a winner; `announcement` is the
 * generic case every client already understands.
 */
const TYPES = ['contest', 'announcement'];

/** The states a row can read as. Only `cancelled` is stored; the rest are the window, read at query time. */
const STATES = ['scheduled', 'active', 'ended', 'cancelled'];

// State is computed in SQL rather than in JavaScript so there is one rule and one comparison convention.
// `datetime()` wraps both sides for the reason the message visibility rule does: this table writes ISO
// strings while neighbouring tables default to CURRENT_TIMESTAMP, and compared raw, 'T' sorts above ' '.
const STATE_EXPR = `
  CASE
    WHEN e.cancelled_at IS NOT NULL THEN 'cancelled'
    WHEN datetime(@now) < datetime(e.starts_at) THEN 'scheduled'
    WHEN datetime(@now) < datetime(e.ends_at) THEN 'active'
    ELSE 'ended'
  END
`;

const SELECT_WITH_STATE = `SELECT e.*, ${STATE_EXPR} AS state`;

/** Newest window first; `id` breaks a same-instant tie so a list can't repeat or skip a row. */
const LIST_ORDER = 'ORDER BY datetime(e.starts_at) DESC, e.id ASC';

const nowOr = (now) => now || new Date().toISOString();

/**
 * Event model — timed community happenings, and the notices the server posts about them.
 *
 * The window is the state: `starts_at`/`ends_at` say whether an event is scheduled, running or over, and
 * nothing writes that answer down, so no writer can leave a row claiming a state its own dates disagree
 * with. The sweeper reacts to the window's edges rather than owning them, which is what makes a missed
 * tick a late broadcast instead of a stranded row.
 */
const Event = {
  TYPES,
  STATES,

  /**
   * Insert one event.
   *
   * @param {Object} data - `{ type, title, bannerText, body, rulesText, posterColor, posterImage,
   *   startsAt, endsAt, createdBy }`
   * @returns {Object} The created row, with its derived state
   */
  create: (data) => {
    const id = uuidv4();
    const stamp = new Date().toISOString();

    db.prepare(`
      INSERT INTO events (
        id, type, title, banner_text, body, rules_text, poster_color, poster_image,
        starts_at, ends_at, created_by, created_at, updated_at
      )
      VALUES (@id, @type, @title, @bannerText, @body, @rulesText, @posterColor, @posterImage,
              @startsAt, @endsAt, @createdBy, @createdAt, @updatedAt)
    `).run({
      id,
      type: data.type || 'announcement',
      title: data.title,
      bannerText: data.bannerText,
      body: data.body,
      rulesText: data.rulesText || null,
      posterColor: data.posterColor || null,
      posterImage: data.posterImage || null,
      startsAt: data.startsAt,
      endsAt: data.endsAt,
      createdBy: data.createdBy || null,
      createdAt: stamp,
      updatedAt: stamp
    });

    return Event.findById(id);
  },

  /**
   * Read one event by ID, whatever state it is in — cancelled rows included.
   *
   * @param {string} id - Event ID
   * @param {string} [now] - The instant to derive state against, for tests
   * @returns {Object|undefined} The row plus `state`, or undefined when there is no such event
   */
  findById: (id, now = undefined) => db
    .prepare(`${SELECT_WITH_STATE} FROM events e WHERE e.id = @id`)
    .get({ id, now: nowOr(now) }),

  /**
   * Every event currently running: started, not yet over, not cancelled.
   *
   * All types, deliberately. The client filters to what it understands, so a type it has never heard of
   * still reaches it and degrades to a plain announcement rather than disappearing.
   *
   * @param {string} [now] - The instant to compare the window against, for tests
   * @returns {Array<Object>} Active events, newest window first
   */
  getActive: (now = undefined) => db.prepare(`
    ${SELECT_WITH_STATE}
    FROM events e
    WHERE e.cancelled_at IS NULL
      AND datetime(e.starts_at) <= datetime(@now)
      AND datetime(@now) < datetime(e.ends_at)
    ${LIST_ORDER}
  `).all({ now: nowOr(now) }),

  /**
   * The list surface: everything that has started, including what has since ended — the archive source.
   *
   * Viewer-dependent in the way a quarantined listing is. A row nobody has been told about yet, or one
   * that was called off, is staff-only: a public list would otherwise leak next month's plans and
   * re-surface events that were deliberately withdrawn.
   *
   * @param {Object} [options] - `{ now, includeUnannounced }`; `includeUnannounced` adds the
   *   future-scheduled and cancelled rows a staff caller may see
   * @returns {Array<Object>} Events, newest window first
   */
  getList: ({ now = undefined, includeUnannounced = false } = {}) => {
    const filter = includeUnannounced
      ? ''
      : 'WHERE e.cancelled_at IS NULL AND datetime(e.starts_at) <= datetime(@now)';

    return db
      .prepare(`${SELECT_WITH_STATE} FROM events e ${filter} ${LIST_ORDER}`)
      .all({ now: nowOr(now) });
  },

  /**
   * Events whose start has passed with nothing announced yet. What the sweeper opens.
   *
   * Having no `start_message_id` is the whole test: the notice is the transition's only lasting effect,
   * so a row that has one has already been started, whatever the timer has or has not done since.
   *
   * @param {string} [now] - The instant to compare against, for tests
   * @returns {Array<Object>} Events due to start
   */
  dueToStart: (now = undefined) => db.prepare(`
    ${SELECT_WITH_STATE}
    FROM events e
    WHERE e.cancelled_at IS NULL
      AND e.start_message_id IS NULL
      AND datetime(e.starts_at) <= datetime(@now)
    ${LIST_ORDER}
  `).all({ now: nowOr(now) }),

  /**
   * Events whose window has closed with the closing still owed.
   *
   * Two things are owed and a row may owe either: the pinned start notice has to come down, for every
   * type, and a contest additionally posts that judging has begun. Asking what is still outstanding
   * rather than asking which rows have ended is what makes a second sweep a no-op.
   *
   * @param {string} [now] - The instant to compare against, for tests
   * @returns {Array<Object>} Events due to end
   */
  dueToEnd: (now = undefined) => db.prepare(`
    ${SELECT_WITH_STATE}
    FROM events e
    LEFT JOIN messages sm ON sm.id = e.start_message_id
    WHERE e.cancelled_at IS NULL
      AND datetime(e.ends_at) <= datetime(@now)
      AND (
        (sm.id IS NOT NULL AND sm.recalled_at IS NULL)
        OR (e.type = 'contest' AND e.end_message_id IS NULL)
      )
    ${LIST_ORDER}
  `).all({ now: nowOr(now) }),

  /**
   * Change an event's authored fields.
   *
   * Only the keys handed in are written, so a caller editing the banner cannot blank the rules by
   * omission. The message ids, the cancellation stamp and the winner are deliberately not reachable
   * here — those are stamped by the transitions that earn them, not typed in.
   *
   * @param {string} id - Event ID
   * @param {Object} fields - Any of `{ title, bannerText, body, rulesText, posterColor, posterImage,
   *   startsAt, endsAt }`
   * @returns {Object|undefined} The updated row, with its derived state
   */
  update: (id, fields) => {
    const columns = {
      title: 'title',
      bannerText: 'banner_text',
      body: 'body',
      rulesText: 'rules_text',
      posterColor: 'poster_color',
      posterImage: 'poster_image',
      startsAt: 'starts_at',
      endsAt: 'ends_at'
    };

    const keys = Object.keys(columns).filter((key) => fields[key] !== undefined);

    if (keys.length) {
      const assignments = keys.map((key) => `${columns[key]} = @${key}`).join(', ');
      const params = keys.reduce((acc, key) => ({ ...acc, [key]: fields[key] }), {});

      db.prepare(`UPDATE events SET ${assignments}, updated_at = @updatedAt WHERE id = @id`)
        .run({ ...params, id, updatedAt: new Date().toISOString() });
    }

    return Event.findById(id);
  },

  /**
   * The contest running right now, if there is one.
   *
   * Singular by construction: overlapping contest windows are refused at the write, so this never has to
   * choose between two. The only contest anything may be entered into, which is what makes naming the
   * wrong one a clean refusal rather than a silent entry in the wrong place.
   *
   * @param {string} [now] - The instant to compare the window against, for tests
   * @returns {Object|undefined} The running contest, or undefined when none is
   */
  activeContest: (now = undefined) => db.prepare(`
    ${SELECT_WITH_STATE}
    FROM events e
    WHERE e.type = 'contest'
      AND e.cancelled_at IS NULL
      AND datetime(e.starts_at) <= datetime(@now)
      AND datetime(@now) < datetime(e.ends_at)
    ${LIST_ORDER}
    LIMIT 1
  `).get({ now: nowOr(now) }),

  /**
   * The contest, if any, whose window a proposed one would overlap.
   *
   * This is the whole of the one-active-contest rule: refuse the write and the invariant holds by
   * construction, so nothing downstream ever has to ask which of two running contests it meant. Windows
   * are compared half-open, matching the state rule — a contest ending at noon and one starting at noon
   * are back to back, not overlapping.
   *
   * Cancelled contests are ignored: calling one off is precisely what frees its window.
   *
   * @param {Object} window - `{ startsAt, endsAt, excludeId }`; `excludeId` is the event being edited,
   *   which must not conflict with itself
   * @returns {Object|undefined} The conflicting row, or undefined when the window is free
   */
  conflictingContest: ({ startsAt, endsAt, excludeId = null }) => db.prepare(`
    ${SELECT_WITH_STATE}
    FROM events e
    WHERE e.type = 'contest'
      AND e.cancelled_at IS NULL
      AND (@excludeId IS NULL OR e.id <> @excludeId)
      AND datetime(e.starts_at) < datetime(@endsAt)
      AND datetime(@startsAt) < datetime(e.ends_at)
    ${LIST_ORDER}
    LIMIT 1
  `).get({ startsAt, endsAt, excludeId, now: nowOr(undefined) }),

  /**
   * Release every world entered into an event.
   *
   * Guarded on the column rather than assuming it: entries arrive in their own ticket, and a cancel that
   * threw on a database without them would make an event impossible to call off.
   *
   * @param {string} id - Event ID
   * @returns {number} How many entries were released
   */
  clearEntries: (id) => {
    const hasColumn = db.prepare('PRAGMA table_info(worlds)').all()
      .some((column) => column.name === 'contest_event_id');

    if (!hasColumn) return 0;

    return db.prepare('UPDATE worlds SET contest_event_id = NULL WHERE contest_event_id = ?').run(id).changes;
  },

  /**
   * Name a contest's winner.
   *
   * The names are stamped rather than joined, for the same reason the audit log stamps its own: the
   * archive has to still read after the listing is gone, and `winner_world_id` is SET NULL on delete
   * precisely so it can go. Written once — a second pick is refused at the route.
   *
   * @param {string} id - Event ID
   * @param {Object} winner - `{ worldId, name, authorName }`
   * @returns {Object|undefined} The updated row
   */
  setWinner: (id, { worldId, name, authorName }) => {
    db.prepare(`
      UPDATE events
      SET winner_world_id = @worldId, winner_name = @name, winner_author_name = @authorName,
          updated_at = @updatedAt
      WHERE id = @id AND winner_world_id IS NULL
    `).run({ id, worldId, name, authorName, updatedAt: new Date().toISOString() });

    return Event.findById(id);
  },

  /**
   * Record the message a transition posted.
   *
   * @param {string} id - Event ID
   * @param {string} field - `start_message_id`, `end_message_id` or `winner_message_id`
   * @param {string} messageId - The posted message's ID
   * @returns {Object|undefined} The updated row
   */
  setMessageId: (id, field, messageId) => {
    // Interpolated into the statement, so it is checked against the list rather than trusted.
    if (!['start_message_id', 'end_message_id', 'winner_message_id'].includes(field)) {
      throw new Error(`Not a message column: ${field}`);
    }

    db.prepare(`UPDATE events SET ${field} = ?, updated_at = ? WHERE id = ?`)
      .run(messageId, new Date().toISOString(), id);

    return Event.findById(id);
  },

  /**
   * Call an event off. Idempotent — a second cancel keeps the first stamp, so its notice is posted once.
   *
   * @param {string} id - Event ID
   * @param {string} [at] - The cancellation instant, for tests
   * @returns {Object|undefined} The updated row
   */
  cancel: (id, at = undefined) => {
    db.prepare('UPDATE events SET cancelled_at = ?, updated_at = ? WHERE id = ? AND cancelled_at IS NULL')
      .run(nowOr(at), new Date().toISOString(), id);

    return Event.findById(id);
  },

  /**
   * Delete an event outright.
   * @param {string} id - Event ID
   * @returns {boolean} Whether a row was removed
   */
  delete: (id) => db.prepare('DELETE FROM events WHERE id = ?').run(id).changes > 0
};

module.exports = Event;
