const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

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
    return db.prepare('SELECT id, username, email, status, account_type, created_at, updated_at FROM users WHERE id = ?').get(id);
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
      
      // Hash new password
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(newPassword, salt);
      
      // Update password in database
      db.prepare(`
        UPDATE users
        SET password = ?, updated_at = ?
        WHERE id = ?
      `).run(hashedPassword, new Date().toISOString(), id);
      
      return true;
    } catch (error) {
      throw error;
    }
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

    let query = `SELECT u.id, u.username, u.email, u.status, u.account_type, u.created_at, u.updated_at ${from}`;
    let countQuery = `SELECT COUNT(*) as count ${from}`;
    const params = [];

    if (search) {
      // Escape LIKE wildcards so a search for `%` matches a literal percent instead of every row.
      const term = `%${String(search).replace(/[\\%_]/g, '\\$&')}%`;
      const clause = " WHERE (u.username LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')";
      query += clause;
      countQuery += clause;
      params.push(term, term);
    }

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
