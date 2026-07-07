const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

/**
 * User model
 */
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

  /**
   * Get all users
   * @returns {Array} Array of user objects
   */
  getAll: () => {
    return db.prepare('SELECT id, username, email, status, account_type, created_at, updated_at FROM users').all();
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
