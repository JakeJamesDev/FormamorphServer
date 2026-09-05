const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { PLACEHOLDER_ID } = require('../config/accountDeletion');
const { foldedAddress } = require('../utils/emailAddress');

/**
 * User model
 */
/**
 * Columns the admin table may order by, keyed by the name a client sends. A whitelist rather than a
 * check: the value is interpolated into the ORDER BY, so nothing outside this map can reach the SQL.
 *
 * Null-prototype, so an inherited name like `constructor` is a miss rather than a hit carrying a
 * function where a column string is expected.
 *
 * `terms` has no column of its own — it is how the user last answered the upload gate, which is only an
 * answer at all while it matches the policy's current version. The buckets read worst-first ascending:
 * unanswered, then declined, then accepted.
 */
const SORT_FIELDS = Object.assign(Object.create(null), {
  username: 'u.username COLLATE NOCASE',
  email: 'u.email COLLATE NOCASE',
  type: 'u.account_type COLLATE NOCASE',
  status: 'u.status COLLATE NOCASE',
  terms: `CASE
    WHEN a.accepted_version IS NULL OR a.accepted_version <> p.acceptance_version THEN 0
    WHEN a.response = 'declined' THEN 1
    ELSE 2
  END`
});

const User = {
  /**
   * Find a user by ID
   * @param {string} id - User ID
   * @returns {Object|null} User object or null if not found
   */
  findById: (id) => {
    // `token_version` is here so a caller minting a token signs the current generation; every response
    // builds its own DTO field by field, so it never reaches a client.
    return db.prepare('SELECT id, username, email, email_verified_at, status, account_type, avatar_file, avatar_updated_at, feed_seen_at, token_version, created_at, updated_at FROM users WHERE id = ?').get(id);
  },

  /**
   * Find a user by username
   * @param {string} username - Username
   * @returns {Object|null} User object or null if not found
   */
  findByUsername: (username) => {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },

  /**
   * Find a user by email address, however either side spells the capitals.
   *
   * `COLLATE NOCASE` here is what lets the unique index on `email` answer the query, and it is the same
   * folding that index applies — so a lookup can never disagree with the constraint about which two
   * spellings are one address.
   *
   * @param {*} email - Whatever arrived in an email field
   * @returns {Object|null} User object, or null when the field carries no address or nobody holds it
   */
  findByEmail: (email) => {
    const address = foldedAddress(email);
    if (!address) return null;

    return db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(address) || null;
  },

  /**
   * Stamp an account's email as proven, if it has not been already.
   *
   * The guard is in the statement rather than around it, so a second link opened at the same moment
   * cannot move a stamp that already stands.
   *
   * @param {string} id - User ID
   * @returns {boolean} Whether this call is the one that stamped it
   */
  markEmailVerified: (id) => db
    .prepare('UPDATE users SET email_verified_at = @now, updated_at = @now WHERE id = @id AND email_verified_at IS NULL')
    .run({ now: new Date().toISOString(), id }).changes > 0,

  /**
   * Create a new user
   * @param {Object} userData - User data
   * @returns {Object} Created user object
   */
  create: async (userData) => {
    try {
      // Generate UUID for user ID
      const userId = uuidv4();
      
      // Hash password
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(userData.password, salt);
      
      // Insert user into database
      db.prepare(`
        INSERT INTO users (id, username, password, email, status, account_type)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        userId,
        userData.username,
        hashedPassword,
        userData.email || null,
        userData.status || 'normal',
        userData.account_type || 'normal'
      );
      
      // Return created user (without password)
      return User.findById(userId);
    } catch (error) {
      throw error;
    }
  },

  /**
   * Update a user
   * @param {string} id - User ID
   * @param {Object} userData - User data to update
   * @returns {Object} Updated user object
   */
  update: (id, userData) => {
    try {
      // Update timestamp
      userData.updated_at = new Date().toISOString();
      
      // Build update query
      const fields = Object.keys(userData).filter(key => key !== 'id');
      const placeholders = fields.map(field => `${field} = ?`).join(', ');
      const values = fields.map(field => userData[field]);
      
      // Add ID to values
      values.push(id);
      
      // Update user in database
      db.prepare(`
        UPDATE users
        SET ${placeholders}
        WHERE id = ?
      `).run(...values);
      
      // Return updated user
      return User.findById(id);
    } catch (error) {
      throw error;
    }
  },

  /**
   * Change a user's password
   * @param {string} id - User ID
   * @param {string} currentPassword - Current password
   * @param {string} newPassword - New password
   * @returns {boolean} True if password was changed successfully
   */
  changePassword: async (id, currentPassword, newPassword) => {
    try {
      // Get user with password
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
      
      if (!user) {
        throw new Error('User not found');
      }
      
      // Check if current password is correct
      const isMatch = await bcrypt.compare(currentPassword, user.password);
      
      if (!isMatch) {
        throw new Error('Current password is incorrect');
      }
      
      return User.setPassword(id, newPassword);
    } catch (error) {
      throw error;
    }
  },

  /**
   * Write a new password, whoever proved they may.
   *
   * The proof lives in the caller: the old password for a change, a mailed token for a reset. What is
   * shared is the write, and the version bump goes in the same statement as the new hash — a password
   * replaced has to end the sessions it protected, or whoever prompted the replacement keeps the session
   * they already hold.
   *
   * @param {string} id - User ID
   * @param {string} newPassword - The password to store
   * @returns {Promise<boolean>} Whether a row was written
   */
  setPassword: async (id, newPassword) => {
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    return db.prepare(`
      UPDATE users
      SET password = ?, token_version = token_version + 1, updated_at = ?
      WHERE id = ?
    `).run(hashedPassword, new Date().toISOString(), id).changes > 0;
  },

  /**
   * Whether this password is the account's.
   *
   * Reads the hash itself rather than handing it to a caller: nothing outside this model has a reason to
   * hold one, and an endpoint that asks somebody to prove who they are only needs the answer.
   *
   * @param {string} id - User ID
   * @param {string} password - The password to check
   * @returns {Promise<boolean>} Whether it matches
   */
  verifyPassword: async (id, password) => {
    const row = db.prepare('SELECT password FROM users WHERE id = ?').get(id);
    if (!row || typeof password !== 'string' || !password) return false;

    return bcrypt.compare(password, row.password);
  },

  /**
   * Stamp an account as asking to be erased.
   *
   * Nothing else changes: the listings, the comments and the profile stay exactly where they are for the
   * whole grace period, which is what makes cancelling free — there is nothing to put back.
   *
   * @param {string} id - User ID
   * @param {boolean} removesContent - Whether their published work goes with the account
   * @returns {string} The ISO timestamp stamped on the row
   */
  requestDeletion: (id, removesContent) => {
    const stamp = new Date().toISOString();

    db.prepare(`
      UPDATE users
      SET deletion_requested_at = ?, deletion_removes_content = ?, updated_at = ?
      WHERE id = ?
    `).run(stamp, removesContent ? 1 : 0, stamp, id);

    return stamp;
  },

  /**
   * When this account asked to be erased, or null when it has not.
   *
   * @param {string} id - User ID
   * @returns {string|null} The ISO timestamp of the standing request
   */
  deletionRequestedAt: (id) => {
    const row = db.prepare('SELECT deletion_requested_at FROM users WHERE id = ?').get(id);

    return row ? row.deletion_requested_at : null;
  },

  /**
   * Take a pending request back.
   *
   * @param {string} id - User ID
   * @returns {boolean} Whether there was one to take back
   */
  cancelDeletion: (id) => {
    const info = db.prepare(`
      UPDATE users
      SET deletion_requested_at = NULL, deletion_removes_content = 0, updated_at = ?
      WHERE id = ? AND deletion_requested_at IS NOT NULL
    `).run(new Date().toISOString(), id);

    return info.changes > 0;
  },

  /**
   * Every account whose request was made before `cutoff`, whole rows, for the sweeper to erase.
   *
   * Both sides are ISO timestamps this server wrote, so they compare as strings — the same comparison
   * `World.expiredQuarantines` makes against its own deadline.
   *
   * @param {string} cutoff - ISO timestamp a request must predate to be due
   * @returns {Array<Object>} The user rows
   */
  deletionsRequestedBefore: (cutoff) => db.prepare(`
    SELECT * FROM users
    WHERE deletion_requested_at IS NOT NULL
      AND deletion_requested_at <= ?
  `).all(cutoff),

  /**
   * Cut every signed-in session for an account loose.
   *
   * Suspending somebody who is already signed in otherwise changed nothing they could feel until their
   * token expired, and a demoted moderator kept their powers for the same window. Bumping the generation
   * is what makes both take effect on the next request instead.
   *
   * @param {string} id - User ID
   * @returns {boolean} Whether a row was updated
   */
  revokeSessions: (id) => {
    const info = db.prepare(`
      UPDATE users
      SET token_version = token_version + 1, updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), id);

    return info.changes > 0;
  },


  /**
   * Point a user at a new profile image, or at none.
   *
   * Returns the filename that was there before, so the caller can delete it — the row is the record of
   * what is current, and an orphaned file on disk is the one thing this cannot clean up itself.
   *
   * @param {string} id - User ID
   * @param {string|null} avatarFile - The stored filename, or null to clear it
   * @returns {string|null} The filename this replaced, or null if there was none
   */
  setAvatar: (id, avatarFile) => {
    const current = db.prepare('SELECT avatar_file FROM users WHERE id = ?').get(id);

    db.prepare('UPDATE users SET avatar_file = ?, avatar_updated_at = ?, updated_at = ? WHERE id = ?')
      .run(avatarFile, new Date().toISOString(), new Date().toISOString(), id);

    return current ? current.avatar_file : null;
  },

  SORT_FIELDS,

  /**
   * Get a page of users, optionally filtered by a username/email substring and ordered by a column.
   *
   * Paged and counted the same way as `World.getAll` so the admin table can share its client logic.
   *
   * Sorting is server-side because the table is paged: ordering only what a page happens to contain
   * would sort ten rows rather than the userbase.
   *
   * @param {Object} [options] - `{ page, limit, search, sort, order }`; `sort` is a `SORT_FIELDS` key
   * @returns {Object} `{ users, count, pagination, total }` — `total` is the match count before paging
   */
  getAll: (options = {}) => {
    const { page = 1, limit = 10, search = '', sort = null, order = 'asc' } = options;
    const offset = (page - 1) * limit;

    // The terms column is not on `users`, so ordering by it needs the answer joined in. The join is
    // always present rather than conditional: one shape is easier to reason about than two.
    const from = `
      FROM users u
      LEFT JOIN policy_acceptances a ON a.user_id = u.id AND a.policy_id = 'upload_gate'
      LEFT JOIN policies p ON p.id = a.policy_id
    `;

    let query = `SELECT u.id, u.username, u.email, u.status, u.account_type, u.avatar_file, u.created_at, u.updated_at ${from}`;
    let countQuery = `SELECT COUNT(*) as count ${from}`;
    // The reserved `[deleted user]` row is left out of every page and every count. It is where a departed
    // account's work is parked rather than somebody staff have business with, and listing it would only
    // invite acting on it.
    const params = [PLACEHOLDER_ID];
    let filter = ' WHERE u.id <> ?';

    if (search) {
      // Escape LIKE wildcards so a search for `%` matches a literal percent instead of every row.
      const term = `%${String(search).replace(/[\\%_]/g, '\\$&')}%`;
      filter += " AND (u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')";
      params.push(term, term);
    }

    query += filter;
    countQuery += filter;

    // `created_at` is CURRENT_TIMESTAMP, i.e. second-resolution, so same-second signups tie. `id` breaks
    // the tie: without it a tied row's page is a query-plan detail, and a page could repeat or skip a user.
    const direction = String(order).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    // Only a known key reaches the SQL — `sort` is a request parameter, and these are interpolated.
    const column = SORT_FIELDS[sort];
    query += column
      ? ` ORDER BY ${column} ${direction}, u.id ASC LIMIT ? OFFSET ?`
      : ' ORDER BY u.created_at DESC, u.id ASC LIMIT ? OFFSET ?';

    const users = db.prepare(query).all(...params, limit, offset);
    const countResult = db.prepare(countQuery).get(...params);
    const total = countResult ? countResult.count : 0;

    const pagination = {};
    if (offset + limit < total) {
      pagination.next = { page: page + 1, limit };
    }
    if (page > 1) {
      pagination.prev = { page: page - 1, limit };
    }

    return { users, count: users.length, pagination, total };
  },

  /**
   * Match a user's password
   * @param {string} enteredPassword - Password to check
   * @param {string} hashedPassword - Hashed password from database
   * @returns {boolean} True if passwords match
   */
  matchPassword: async (enteredPassword, hashedPassword) => {
    return await bcrypt.compare(enteredPassword, hashedPassword);
  }
};

module.exports = User;
