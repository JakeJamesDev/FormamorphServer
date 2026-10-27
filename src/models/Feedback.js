const db = require('../config/db');
const { isStaff, STAFF_ROLES } = require('../config/roles');
const { v4: uuidv4 } = require('uuid');

/** The three branches of the tree. They share a thread, a status and a read-marker; little else. */
const TYPES = ['bug', 'suggestion', 'question'];

/**
 * What a piece of feedback is about, per type. A bug's list starts at the machine and works outwards; a
 * suggestion's is about the game; a question's is about where the asker is stuck. No list would serve
 * another — 'crash' is not a thing to suggest, and 'interface' is not a thing to crash.
 */
const CATEGORIES = {
  bug: ['crash', 'ai', 'editor', 'community', 'visuals', 'other'],
  suggestion: ['gameplay', 'writing', 'editor', 'community', 'interface', 'other'],
  question: ['gameplay', 'editor', 'setup', 'community', 'account', 'other']
};

/**
 * Where a thread sits, per type. A bug is triaged towards a fix; a suggestion is weighed and then
 * committed to or turned down, so 'confirmed' and 'planned' are different promises. A question is
 * `answered` only by accepting a reply, never through the status route.
 */
const STATUSES = {
  bug: ['open', 'need_info', 'confirmed', 'resolved', 'wontfix'],
  suggestion: ['open', 'considering', 'planned', 'declined', 'done'],
  question: ['open', 'answered', 'closed']
};

/** The statuses staff may set on a question by hand. */
const QUESTION_SET_STATUSES = ['open', 'closed'];

/**
 * Whether a type is a public board: open to replies from anyone signed in, and to votes.
 * @param {string} type - A `TYPES` value
 * @returns {boolean} True for suggestions and questions
 */
const isVotableBoard = (type) => type === 'suggestion' || type === 'question';

/**
 * The status a question ends at: `closed` stays closed, and otherwise an accepted answer makes it
 * `answered` and none makes it `open`.
 * @param {string} status - The status asked for, `open` or `closed`
 * @param {boolean} hasAnswer - Whether the question has an accepted answer
 * @returns {string} A question status
 */
const questionStatus = (status, hasAnswer) => {
  if (status === 'closed') return 'closed';
  return hasAnswer ? 'answered' : 'open';
};

/** Caps, mirrored by the client so its field limits agree with what this will accept. */
const TITLE_MAX = 120;
const BODY_MAX = 4000;
const COMMENT_MAX = 4000;
/** Diagnostics are a small fixed blob; a cap stops the field being used as free storage. */
const DIAGNOSTICS_MAX = 2000;
/** Longer search text is cut to this, not refused; the client's field holds the same limit. */
const SEARCH_MAX = 200;

/**
 * The distinct words of a search text. Words under 3 characters are dropped, except a 2-character
 * word typed in capitals (AI, UI).
 * @param {*} search - The raw search parameter
 * @returns {string[]} Lower-cased words, in typed order
 */
const searchWords = (search) => {
  const text = String(search ?? '').trim().slice(0, SEARCH_MAX);
  const kept = text.split(/\s+/).filter((word) => word.length >= 3 || /^[A-Z]{2}$/.test(word));
  return [...new Set(kept.map((word) => word.toLowerCase()))];
};

/**
 * The thread row, its author's name, the two counts a list shows on it, and its accepted answer.
 *
 * Votes are joined rather than counted per row: the list is paged and sortable by them, so counting one
 * page's worth would rank ten rows against each other instead of the whole board. The reply count rides
 * along for the same reason a list needs it at all — one subquery beats a query per row. The accepted
 * answer's columns are prefixed `answer_`, null when there is none.
 */
const FEEDBACK_SELECT = `
  SELECT r.*,
         u.username AS reporter_username,
         u.avatar_file AS reporter_avatar_file,
         u.account_type AS reporter_account_type,
         (SELECT COUNT(*) FROM feedback_votes v WHERE v.feedback_id = r.id) AS vote_count,
         (SELECT COUNT(*) FROM feedback_comments c WHERE c.feedback_id = r.id) AS comment_count,
         ac.body AS answer_body,
         ac.created_at AS answer_created_at,
         ac.edited_at AS answer_edited_at,
         ac.author_id AS answer_author_id,
         ac.author_role AS answer_author_role,
         au.username AS answer_author_username,
         au.account_type AS answer_author_account_type,
         au.avatar_file AS answer_author_avatar_file
  FROM feedback r
  LEFT JOIN users u ON u.id = r.reporter_id
  LEFT JOIN feedback_comments ac ON ac.id = r.accepted_comment_id
  LEFT JOIN users au ON au.id = ac.author_id
`;

/**
 * Whether a thread is one this reader is a party to, which is what makes a new comment in it *news*
 * rather than something they happened to walk past.
 *
 * The branches answer it differently. A bug is between its reporter and the team, so admins are a
 * party to every one — that is what makes the queue badge work. A suggestion is open to everyone, where
 * the only meaningful line is whether you have written in it: filed it, or replied to it — or been
 * mentioned in it, which pulls you in as a reply would. A question adds its voters, since a "me too" is
 * waiting on the answer as much as the asker is. A mention in a bug grants nothing. Staff get no blanket
 * claim on suggestions or questions. Must agree with `hasParticipated`.
 *
 * @param {boolean} isAdmin - Whether the reader is an admin
 * @returns {string} A SQL predicate over `r`, reading `@userId`
 */
const participationClause = (isAdmin) => `
  (
    (r.type = 'bug' AND (${isAdmin ? '1 = 1' : '0 = 1'} OR r.reporter_id = @userId))
    OR
    (r.type IN ('suggestion', 'question') AND (
      r.reporter_id = @userId
      OR EXISTS (
        SELECT 1 FROM feedback_comments mine
        WHERE mine.feedback_id = r.id AND mine.author_id = @userId
      )
      OR EXISTS (
        SELECT 1 FROM feedback_mentions mention
        WHERE mention.feedback_id = r.id AND mention.user_id = @userId
      )
      OR (r.type = 'question' AND EXISTS (
        SELECT 1 FROM feedback_votes myvote
        WHERE myvote.feedback_id = r.id AND myvote.user_id = @userId
      ))
    ))
  )
`;

/**
 * Whether a thread holds something this reader has not seen: somebody else's comment, or, on a
 * suggestion or a question, a mention of them. A SQL predicate over `r` and the reader's marker `s`,
 * reading `@userId`; pairs with `participationClause`.
 */
const NEWS_CLAUSE = `
  (
    EXISTS (
      SELECT 1 FROM feedback_comments c
      WHERE c.feedback_id = r.id
        AND (c.author_id IS NULL OR c.author_id <> @userId)
        AND (s.last_seen_at IS NULL OR c.created_at > s.last_seen_at)
    )
    OR (r.type IN ('suggestion', 'question') AND EXISTS (
      SELECT 1 FROM feedback_mentions m
      WHERE m.feedback_id = r.id AND m.user_id = @userId
        AND (s.last_seen_at IS NULL OR m.created_at > s.last_seen_at)
    ))
  )
`;

/**
 * Make one post's mention rows match the users it now mentions. A mention kept across an edit keeps its
 * time, so re-saving a post never badges anyone again. Call inside the write's transaction.
 *
 * @param {string} feedbackId - Feedback ID
 * @param {string|null} commentId - The comment, or null for the thread body
 * @param {Array<string>} userIds - Everyone the post mentions now
 * @param {string} now - The write's ISO time
 */
const setMentions = (feedbackId, commentId, userIds, now) => {
  const kept = new Set(userIds);
  const stored = db.prepare('SELECT user_id FROM feedback_mentions WHERE feedback_id = ? AND comment_id IS ?')
    .all(feedbackId, commentId).map((row) => row.user_id);

  const remove = db.prepare('DELETE FROM feedback_mentions WHERE feedback_id = ? AND comment_id IS ? AND user_id = ?');
  for (const userId of stored) if (!kept.has(userId)) remove.run(feedbackId, commentId, userId);

  const add = db.prepare('INSERT INTO feedback_mentions (feedback_id, comment_id, user_id, created_at) VALUES (?, ?, ?, ?)');
  for (const userId of kept) if (!stored.includes(userId)) add.run(feedbackId, commentId, userId, now);
};

/** Orders the list may be asked for. A whitelist: the value is interpolated into the ORDER BY. */
const SORT_FIELDS = Object.assign(Object.create(null), {
  newest: 'r.created_at DESC, r.rowid DESC',
  oldest: 'r.created_at ASC, r.rowid DESC',
  // Replies and status changes touch `updated_at`; ties fall back to newest.
  active: 'r.updated_at DESC, r.created_at DESC, r.rowid DESC',
  // Ties on votes fall back to newest, so an unvoted board still reads in a sensible order.
  votes: 'vote_count DESC, r.created_at DESC, r.rowid DESC'
});

/**
 * User-filed feedback — bug reports, suggestions and questions — and the comment thread on each.
 */
const Feedback = {
  TYPES,
  CATEGORIES,
  STATUSES,
  QUESTION_SET_STATUSES,
  SORT_FIELDS,
  isVotableBoard,
  questionStatus,
  TITLE_MAX,
  BODY_MAX,
  COMMENT_MAX,
  DIAGNOSTICS_MAX,
  SEARCH_MAX,

  /**
   * File a bug report, a suggestion or a question.
   *
   * A suggestion or a question is auto-voted by its author in the same transaction: nobody files something
   * they don't want, and a board of zeroes reads as nobody caring.
   *
   * @param {Object} data - `{ type, reporterId, title, category, body, diagnostics, mentions }`; `mentions`
   *   is the user ids the body mentions
   * @returns {Object} The stored thread
   */
  create: ({ type = 'bug', reporterId, reporterRole = null, title, category, body, diagnostics, mentions = [] }) => {
    const id = uuidv4();
    const now = new Date().toISOString();

    db.transaction(() => {
      // The counter never goes down, so a deleted thread's number is not handed out again. It also clears
      // any number stored past it, such as one written by hand.
      const { next } = db.prepare(`
        INSERT INTO feedback_sequence (id, last_number)
        VALUES (1, (SELECT COALESCE(MAX(number), 0) + 1 FROM feedback))
        ON CONFLICT(id) DO UPDATE SET last_number = MAX(last_number, (SELECT COALESCE(MAX(number), 0) FROM feedback)) + 1
        RETURNING last_number AS next
      `).get();
      db.prepare(`
        INSERT INTO feedback (id, number, type, reporter_id, reporter_role, title, category, body, status, diagnostics, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
      `).run(id, next, type, reporterId, reporterRole, title, category, body, JSON.stringify(diagnostics || {}), now, now);
      setMentions(id, null, mentions, now);

      if (isVotableBoard(type)) {
        db.prepare('INSERT INTO feedback_votes (feedback_id, user_id, created_at) VALUES (?, ?, ?)')
          .run(id, reporterId, now);
      }
    })();

    return Feedback.findById(id);
  },

  /**
   * Read one thread.
   * @param {string} id - Feedback ID
   * @returns {Object|undefined} The row, or undefined when there is no such thread
   */
  findById: (id) => db.prepare(`${FEEDBACK_SELECT} WHERE r.id = ?`).get(id),

  /**
   * Read one thread by its number.
   * @param {number} number - The thread number
   * @returns {Object|undefined} The row, or undefined when there is no such thread
   */
  findByNumber: (number) => db.prepare(`${FEEDBACK_SELECT} WHERE r.number = ?`).get(number),

  /**
   * The threads among these numbers, in one query however many numbers.
   * @param {Array<number>} numbers - Thread numbers
   * @returns {Array<Object>} `{ number, title, type, status }` rows
   */
  findByNumbers: (numbers) => db.prepare('SELECT number, title, type, status FROM feedback WHERE number IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(numbers)),

  /**
   * Read one thread by whichever name the caller has: a UUID, or digits for a number.
   * @param {string} ref - A feedback ID or a thread number
   * @returns {Object|undefined} The row, or undefined when there is no such thread
   */
  findByRef: (ref) => (/^[1-9]\d{0,14}$/.test(ref) ? Feedback.findByNumber(Number(ref)) : Feedback.findById(ref)),

  /**
   * A page of threads.
   *
   * `type` picks the branch; `reporterId` narrows to one person's own; `statuses` to any of several triage states;
   * `category` to one area of the app; `search` to threads whose title or body holds any of its words, best match first. All are
   * optional and combine, so the same query backs the reporter's list, the public board and the admin's
   * filtered queue.
   *
   * @param {Object} [options] - `{ page, limit, type, reporterId, statuses, category, search, sort }`; `sort` is a
   *   `SORT_FIELDS` key (`newest`, `oldest`, `active`, `votes`), defaulting to newest
   * @returns {Object} `{ threads, count, total }` — `total` is the match count before paging
   */
  getAll: (options = {}) => {
    const {
      page = 1, limit = 20, type = null, reporterId = null, statuses = [], category = null, search = '',
      sort = 'newest'
    } = options;
    const offset = (page - 1) * limit;

    const where = [];
    const params = {};
    if (type) {
      where.push('r.type = @type');
      params.type = type;
    }
    if (reporterId) {
      where.push('r.reporter_id = @reporterId');
      params.reporterId = reporterId;
    }
    if (statuses.length) {
      // One bound placeholder per value, so the list is never interpolated.
      where.push(`r.status IN (${statuses.map((_, index) => `@status${index}`).join(', ')})`);
      statuses.forEach((value, index) => { params[`status${index}`] = value; });
    }
    if (category) {
      where.push('r.category = @category');
      params.category = category;
    }
    const words = searchWords(search);
    let rank = '';
    if (words.length) {
      // One bound LIKE per word, escaped so `%` and `_` match themselves. LIKE ignores ASCII case.
      const hits = words.map((word, index) => {
        params[`word${index}`] = `%${word.replace(/[\\%_]/g, '\\$&')}%`;
        return `(r.title LIKE @word${index} ESCAPE '\\' OR r.body LIKE @word${index} ESCAPE '\\')`;
      });
      where.push(`(${hits.join(' OR ')})`);
      rank = `(${hits.map((hit) => `(CASE WHEN ${hit} THEN 1 ELSE 0 END)`).join(' + ')}) DESC, `;
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // `created_at` is an ISO string written per row, but two threads filed in the same millisecond tie.
    // `rowid` breaks it by real insertion order — the primary key is a random UUID, so ordering on that
    // would shuffle same-instant rows and a thread could repeat or vanish between pages.
    // Only a known key reaches the SQL; `sort` is a request parameter, and these are interpolated.
    // Votes rank the public boards only; a bug has none, so that sort reads as newest.
    const key = sort === 'votes' && type && !isVotableBoard(type) ? 'newest' : sort;
    const order = SORT_FIELDS[key] || SORT_FIELDS.newest;

    const threads = db.prepare(`
      ${FEEDBACK_SELECT}
      ${filter}
      ORDER BY ${rank}${order}
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });

    const countRow = db.prepare(`SELECT COUNT(*) AS count FROM feedback r ${filter}`).get(params);

    return { threads, count: threads.length, total: countRow ? countRow.count : 0 };
  },

  /**
   * Accounts whose username starts with the prefix, the thread's reporter and commenters first.
   * Only names a mention can parse (`[A-Za-z0-9_-]{3,20}`), never a suspended or rename-flagged account.
   * An empty prefix lists the thread's participants alone, and nothing without a thread.
   * @param {Object} options - `{ prefix, thread, limit }`; `thread` is a row, or none
   * @returns {Object[]} `{ id, username, avatar_file, account_type, participant }` rows
   */
  searchUsers: ({ prefix = '', thread = null, limit = 8 }) => {
    const text = String(prefix).trim();
    if (!text && !thread) return [];
    const participant = thread
      ? `(u.id = @reporterId OR EXISTS (
           SELECT 1 FROM feedback_comments c WHERE c.feedback_id = @threadId AND c.author_id = u.id))`
      : '0';
    return db.prepare(`
      SELECT u.id, u.username, u.avatar_file, u.account_type, ${participant} AS participant
      FROM users u
      WHERE u.username LIKE @pattern ESCAPE '\\' ${text ? '' : `AND ${participant}`}
        AND LENGTH(u.username) BETWEEN 3 AND 20 AND u.username NOT GLOB '*[^A-Za-z0-9_-]*'
        AND u.status != 'suspended' AND u.username_rename_required = 0
      ORDER BY participant DESC, u.username COLLATE NOCASE, u.id
      LIMIT @limit
    `).all({
      pattern: `${text.replace(/[\\%_]/g, '\\$&')}%`,
      reporterId: thread ? thread.reporter_id : null,
      threadId: thread ? thread.id : null,
      limit
    });
  },

  /**
   * Threads whose number starts with the digits typed, or whose title has a word starting with each typed
   * word. An exact number ranks first, then the newest.
   * Rows `readable` rejects are skipped before the limit counts, so unreadable matches never hide readable ones.
   * @param {Object} options - `{ query, types, limit, readable }`; `types` narrows to those thread types, `readable` takes a row
   * @returns {Object[]} The matching rows, `number`, `title`, `type` and `status` among their columns
   */
  searchThreads: ({ query = '', types = [], limit = 8, readable = () => true }) => {
    const text = String(query).trim().slice(0, SEARCH_MAX);
    const digits = /^\d{1,15}$/.test(text) ? text : '';
    const words = searchWords(digits ? '' : text);
    const params = { limit };
    const hits = [];
    if (digits) {
      params.numberPrefix = `${digits}%`;
      hits.push('CAST(r.number AS TEXT) LIKE @numberPrefix');
    }
    words.forEach((word, index) => {
      const escaped = word.replace(/[\\%_]/g, '\\$&');
      params[`start${index}`] = `${escaped}%`;
      params[`inside${index}`] = `% ${escaped}%`;
      hits.push(`(r.title LIKE @start${index} ESCAPE '\\' OR r.title LIKE @inside${index} ESCAPE '\\')`);
    });
    if (!hits.length) return [];
    const where = [`(${hits.join(' AND ')})`];
    if (types.length) {
      where.push(`r.type IN (${types.map((_, index) => `@type${index}`).join(', ')})`);
      types.forEach((value, index) => { params[`type${index}`] = value; });
    }
    params.exact = digits ? Number(digits) : -1;
    const page = db.prepare(`
      SELECT r.id, r.reporter_id, r.number, r.title, r.type, r.status
      FROM feedback r
      WHERE ${where.join(' AND ')}
      ORDER BY (r.number = @exact) DESC, r.created_at DESC, r.rowid DESC
      LIMIT @limit OFFSET @offset
    `);
    const found = [];
    for (let offset = 0; found.length < limit; offset += limit) {
      const rows = page.all({ ...params, offset });
      for (const row of rows) {
        if (readable(row)) found.push(row);
        if (found.length === limit) break;
      }
      if (rows.length < limit) break;
    }
    return found;
  },


  /**
   * Rewrite a report.
   *
   * Every field is optional; only what is passed is written. A type move is the one change that pulls
   * others with it, so it is handled in one statement rather than as a sequence somebody could interrupt:
   * the category must come from the new type's list, the status returns to `open` — the only value every
   * branch shares — and a bug's diagnostics are deleted rather than hidden, since a board post is public
   * and the version/platform line was collected under bug rules.
   *
   * Votes stay across a move; an accepted answer does not. A move into a question makes every voter a party
   * to it, and a move out of bugs does the same for everyone mentioned, so each gets a read marker in the
   * same transaction: the move alone must not raise their badge.
   *
   * @param {string} id - Feedback ID
   * @param {Object} fields - `{ title, body, category, type, mentions }`, any subset; `mentions` goes with
   *   `body` and is the user ids it mentions
   * @returns {Object|undefined} The updated thread
   */
  update: (id, { title, body, category, type, mentions = [] } = {}) => {
    const sets = [];
    const params = [];

    if (title !== undefined) { sets.push('title = ?'); params.push(title); }
    if (body !== undefined) { sets.push('body = ?'); params.push(body); }
    if (category !== undefined) { sets.push('category = ?'); params.push(category); }
    if (type !== undefined) {
      sets.push('type = ?', "status = 'open'", "diagnostics = '{}'", 'accepted_comment_id = NULL');
      params.push(type);
    }

    if (sets.length === 0) return Feedback.findById(id);

    const now = new Date().toISOString();
    db.transaction(() => {
      const before = db.prepare('SELECT type, reporter_id FROM feedback WHERE id = ?').get(id);
      db.prepare(`UPDATE feedback SET ${sets.join(', ')}, edited_at = ?, updated_at = ? WHERE id = ?`)
        .run(...params, now, now, id);

      // Before this write's own mentions are stored: one added now is news, not part of the move.
      if (before && before.type === 'bug' && isVotableBoard(type)) {
        // The reporter and staff were parties to the bug already, so their unread state stands.
        db.prepare(`
          INSERT INTO feedback_reads (feedback_id, user_id, last_seen_at)
          SELECT DISTINCT m.feedback_id, m.user_id, @now FROM feedback_mentions m
          JOIN users u ON u.id = m.user_id
          WHERE m.feedback_id = @id AND m.user_id IS NOT @reporter
            AND u.account_type NOT IN (SELECT value FROM json_each(@staff))
          ON CONFLICT(feedback_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
        `).run({ id, now, reporter: before.reporter_id, staff: JSON.stringify(STAFF_ROLES) });
      }
      if (body !== undefined) setMentions(id, null, mentions, now);
      if (type === 'question') {
        db.prepare(`
          INSERT INTO feedback_reads (feedback_id, user_id, last_seen_at)
          SELECT feedback_id, user_id, @now FROM feedback_votes WHERE feedback_id = @id
          ON CONFLICT(feedback_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
        `).run({ id, now });
      }
    })();

    return Feedback.findById(id);
  },

  /**
   * Move a thread through triage, and lock or unlock it in the same statement when asked. Locking a thread
   * that is already locked keeps its original lock time.
   * @param {string} id - Feedback ID
   * @param {string} status - One of `STATUSES` for that thread's type
   * @param {Object} [options] - `{ locked }`; left out, the lock is untouched
   * @returns {Object|undefined} The updated thread
   */
  setStatus: (id, status, { locked } = {}) => {
    const now = new Date().toISOString();
    if (locked === undefined) {
      db.prepare('UPDATE feedback SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
    } else if (locked) {
      db.prepare('UPDATE feedback SET status = ?, locked_at = COALESCE(locked_at, ?), updated_at = ? WHERE id = ?')
        .run(status, now, now, id);
    } else {
      db.prepare('UPDATE feedback SET status = ?, locked_at = NULL, updated_at = ? WHERE id = ?').run(status, now, id);
    }

    return Feedback.findById(id);
  },

  /**
   * Store or clear a question's accepted answer. An open question becomes `answered` and back; a closed
   * one keeps its status.
   *
   * @param {Object} thread - The question row
   * @param {string|null} commentId - A comment on this thread, or null to clear
   * @returns {Object|undefined} The updated thread
   */
  setAnswer: (thread, commentId) => {
    const status = questionStatus(thread.status, Boolean(commentId));

    db.prepare('UPDATE feedback SET accepted_comment_id = ?, status = ?, updated_at = ? WHERE id = ?')
      .run(commentId, status, new Date().toISOString(), thread.id);

    return Feedback.findById(thread.id);
  },

  /**
   * Close a thread to further replies, or reopen it. Orthogonal to status: a thread can be locked at any
   * point in triage, and reaching `done` locks nothing by itself.
   *
   * @param {string} id - Feedback ID
   * @param {boolean} locked - Whether it should be locked
   * @returns {Object|undefined} The updated thread
   */
  setLocked: (id, locked) => {
    db.prepare('UPDATE feedback SET locked_at = ? WHERE id = ?')
      .run(locked ? new Date().toISOString() : null, id);

    return Feedback.findById(id);
  },

  /**
   * Delete a thread. Its comments, votes and read-state go with it (ON DELETE CASCADE).
   * @param {string} id - Feedback ID
   */
  delete: (id) => {
    db.prepare('DELETE FROM feedback WHERE id = ?').run(id);
  },

  /**
   * Whether this user may read a thread. Any signed-in account: the queue is public so somebody can
   * check whether what they hit is already known — or already suggested — before filing it again.
   * A guest may read a Votable board only; a bug's diagnostics never reach the web.
   *
   * @param {Object} thread - The thread row
   * @param {Object} [user] - `{ id, account_type }`, or none for a guest
   * @returns {boolean} True when the user may read it
   */
  canRead: (thread, user) => Boolean(thread && (user || isVotableBoard(thread.type))),

  /**
   * Whether this user may list a branch. A guest has no list of their own, and the bug queue stays off
   * the web, so a guest lists a Votable board with `scope=all` only.
   *
   * @param {Object} query - `{ type, scope }`, the type already resolved
   * @param {Object} [user] - `{ id, account_type }`, or none for a guest
   * @returns {boolean} True when the user may list it
   */
  canList: ({ type, scope }, user) => Boolean(user || (scope === 'all' && isVotableBoard(type))),

  /**
   * Whether this user may write in a thread.
   *
   * A bug stays between the person who hit it and the people fixing it. A suggestion or a question is a
   * discussion, so anyone signed in may join — until an admin locks it, which stops everyone but them.
   *
   * @param {Object} thread - The thread row
   * @param {Object} user - `{ id, account_type }`
   * @returns {boolean} True when the user may comment
   */
  canWrite: (thread, user) => {
    if (!thread || !user) return false;
    // Locking is a moderation tool, so it never locks out the moderators.
    if (isStaff(user)) return true;
    if (thread.locked_at) return false;

    return isVotableBoard(thread.type) || thread.reporter_id === user.id;
  },

  /**
   * The comments on a thread, oldest first.
   * @param {string} feedbackId - Feedback ID
   * @returns {Array<Object>} Comments with their author's name and account type
   */
  comments: (feedbackId) => db.prepare(`
    SELECT c.*, u.username AS author_username, u.account_type AS author_account_type,
             u.avatar_file AS author_avatar_file
    FROM feedback_comments c
    LEFT JOIN users u ON u.id = c.author_id
    WHERE c.feedback_id = ?
    ORDER BY c.created_at ASC, c.rowid ASC
  `).all(feedbackId),

  /**
   * Add a comment, and touch the thread so an admin's queue sorts by real activity.
   *
   * @param {Object} data - `{ feedbackId, authorId, body, authorRole, mentions }`; `mentions` is the user
   *   ids the body mentions
   * @returns {Object} The stored comment
   */
  addComment: ({ feedbackId, authorId, body, authorRole = null, mentions = [] }) => {
    const id = uuidv4();
    const now = new Date().toISOString();

    db.transaction(() => {
      // `authorRole` is a snapshot, not a join: a reply signed by the team has to keep saying so after the
      // person who wrote it stops being staff, and must not start saying so when somebody is promoted.
      db.prepare(`
        INSERT INTO feedback_comments (id, feedback_id, author_id, body, created_at, author_role)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, feedbackId, authorId, body, now, authorRole);
      db.prepare('UPDATE feedback SET updated_at = ? WHERE id = ?').run(now, feedbackId);
      setMentions(feedbackId, id, mentions, now);
    })();

    return db.prepare(`
      SELECT c.*, u.username AS author_username, u.account_type AS author_account_type,
             u.avatar_file AS author_avatar_file
      FROM feedback_comments c
      LEFT JOIN users u ON u.id = c.author_id
      WHERE c.id = ?
    `).get(id);
  },

  /**
   * Read one comment, without its author's name — enough to check who wrote it.
   * @param {string} id - Comment ID
   * @returns {Object|undefined} The comment row, or undefined when there is no such row
   */
  findComment: (id) => db.prepare('SELECT * FROM feedback_comments WHERE id = ?').get(id),

  /**
   * Rewrite a comment, stamping `edited_at` so the thread can say so.
   *
   * @param {Object} comment - The comment row, `{ id, feedback_id }`
   * @param {string} body - The new text
   * @param {Array<string>} [mentions] - The user ids the new text mentions
   * @returns {Object} The updated comment, with its author's name
   */
  updateComment: ({ id, feedback_id: feedbackId }, body, mentions = []) => {
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE feedback_comments SET body = ?, edited_at = ? WHERE id = ?').run(body, now, id);
      setMentions(feedbackId, id, mentions, now);
    })();

    return db.prepare(`
      SELECT c.*, u.username AS author_username, u.account_type AS author_account_type,
             u.avatar_file AS author_avatar_file
      FROM feedback_comments c
      LEFT JOIN users u ON u.id = c.author_id
      WHERE c.id = ?
    `).get(id);
  },

  /**
   * Remove a comment outright, and its mentions with it (ON DELETE CASCADE). The thread's own `updated_at`
   * is left alone: it records when the thread last had something to read, and taking words away is not
   * new activity to sort a queue by.
   *
   * @param {string} id - Comment ID
   */
  deleteComment: (id) => {
    db.prepare('DELETE FROM feedback_comments WHERE id = ?').run(id);
  },

  /**
   * Whether this user has written in a thread — filed it, or replied to it — or, on a suggestion or a
   * question, been mentioned in it, or, on a question, voted on it. What decides whether a new comment is
   * theirs to be told about, and so whether reading records a marker at all. Must agree with
   * `participationClause`.
   *
   * @param {Object} thread - The thread row
   * @param {string} userId - User ID
   * @returns {boolean} True when they are a party to it
   */
  hasParticipated: (thread, userId) => {
    if (!thread || !userId) return false;
    if (thread.reporter_id === userId) return true;

    const row = db.prepare('SELECT 1 AS found FROM feedback_comments WHERE feedback_id = ? AND author_id = ? LIMIT 1')
      .get(thread.id, userId);
    if (row) return true;
    if (!isVotableBoard(thread.type)) return false;

    const mentioned = db.prepare('SELECT 1 AS found FROM feedback_mentions WHERE feedback_id = ? AND user_id = ? LIMIT 1')
      .get(thread.id, userId);
    if (mentioned) return true;

    return thread.type === 'question' && Feedback.hasVoted(thread.id, userId);
  },

  /**
   * Record that this user has read the thread as it stands.
   * @param {string} feedbackId - Feedback ID
   * @param {string} userId - User ID
   */
  markSeen: (feedbackId, userId) => {
    db.prepare(`
      INSERT INTO feedback_reads (feedback_id, user_id, last_seen_at)
      VALUES (?, ?, ?)
      ON CONFLICT(feedback_id, user_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
    `).run(feedbackId, userId, new Date().toISOString());
  },

  /**
   * How many of this user's threads hold something they have not seen.
   *
   * Only somebody else's comments count — your own reply is not news to you — and a thread never read
   * counts as soon as anyone else has written in it. A mention is news too, until read. Which threads
   * count as theirs differs by type; see `participationClause`.
   *
   * Compared as raw ISO strings rather than through `datetime()`, which truncates to whole seconds: a
   * reply landing in the same second as the read would otherwise never raise the badge.
   *
   * @param {Object} user - `{ id, account_type }`
   * @returns {number} Threads with something new in them
   */
  unreadCount: (user) => {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM feedback r
      LEFT JOIN feedback_reads s ON s.feedback_id = r.id AND s.user_id = @userId
      WHERE ${participationClause(isStaff(user))}
        AND ${NEWS_CLAUSE}
    `).get({ userId: user.id });

    return row ? row.count : 0;
  },

  /**
   * Which of the given threads hold something this user has not seen, so a list can flag them without a
   * query per row. Scoped exactly as `unreadCount` — a thread somebody is merely reading is never
   * unread to them, since reading it records no marker they could ever clear.
   *
   * @param {Array<string>} ids - Feedback IDs
   * @param {Object} user - `{ id, account_type }`
   * @returns {Set<string>} The IDs with something new in them
   */
  unreadAmong: (ids, user) => {
    if (!ids || ids.length === 0) return new Set();

    const placeholders = ids.map((_, index) => `@id${index}`).join(', ');
    const idParams = Object.fromEntries(ids.map((id, index) => [`id${index}`, id]));

    const rows = db.prepare(`
      SELECT r.id
      FROM feedback r
      LEFT JOIN feedback_reads s ON s.feedback_id = r.id AND s.user_id = @userId
      WHERE r.id IN (${placeholders})
        AND ${participationClause(isStaff(user))}
        AND ${NEWS_CLAUSE}
    `).all({ userId: user.id, ...idParams });

    return new Set(rows.map((row) => row.id));
  },

  /**
   * Add or remove this user's vote. Idempotent in both directions.
   *
   * A vote on a question makes the voter a party to it, so it also records a read marker: replies written
   * before the vote are not news to them.
   *
   * @param {Object} thread - The thread row
   * @param {string} userId - User ID
   * @param {boolean} voted - Whether they want their vote on it
   */
  setVote: (thread, userId, voted) => {
    const feedbackId = thread.id;
    if (voted) {
      db.transaction(() => {
        const { changes } = db.prepare(`
          INSERT INTO feedback_votes (feedback_id, user_id, created_at) VALUES (?, ?, ?)
          ON CONFLICT(feedback_id, user_id) DO NOTHING
        `).run(feedbackId, userId, new Date().toISOString());
        // Only a new vote: re-sending one is not a read.
        if (changes === 1 && thread.type === 'question') Feedback.markSeen(feedbackId, userId);
      })();
      return;
    }

    db.prepare('DELETE FROM feedback_votes WHERE feedback_id = ? AND user_id = ?').run(feedbackId, userId);
  },

  /**
   * Whether this user has voted for a thread.
   * @param {string} feedbackId - Feedback ID
   * @param {string} userId - User ID
   * @returns {boolean} True when their vote is on it
   */
  hasVoted: (feedbackId, userId) => Boolean(
    db.prepare('SELECT 1 AS found FROM feedback_votes WHERE feedback_id = ? AND user_id = ?')
      .get(feedbackId, userId)
  ),

  /**
   * Which of the given threads this user has voted for, so a list can fill its buttons in without a
   * query per row.
   *
   * @param {Array<string>} ids - Feedback IDs
   * @param {string} userId - User ID
   * @returns {Set<string>} The IDs they have voted for
   */
  votedAmong: (ids, userId) => {
    if (!ids || ids.length === 0) return new Set();

    const placeholders = ids.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT feedback_id FROM feedback_votes
      WHERE user_id = ? AND feedback_id IN (${placeholders})
    `).all(userId, ...ids);

    return new Set(rows.map((row) => row.feedback_id));
  }
};

module.exports = Feedback;
