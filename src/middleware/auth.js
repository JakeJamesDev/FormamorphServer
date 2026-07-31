const jwt = require('jsonwebtoken');
const db = require('../config/db');

/**
 * Build an authentication middleware.
 *
 * @param {Object} [options] - `{ allowSuspended }` — when true, a suspended account may also make
 *   write requests. Only for routes that write nothing but the caller's own read/dismiss state.
 * @returns {Function} Express middleware
 */
const authenticate = ({ allowSuspended = false } = {}) => async (req, res, next) => {
  let token;

  // Check if token exists in Authorization header
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    // Get token from header
    token = req.headers.authorization.split(' ')[1];
  }

  // Check if token exists
  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Not authorized to access this route'
    });
  }

  try {
    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Get user from database
    const user = db.prepare('SELECT id, username, email, status, account_type, created_at FROM users WHERE id = ?').get(decoded.id);

    // Check if user exists
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized to access this route'
      });
    }

    // Check if user is suspended
    if (!allowSuspended && user.status === 'suspended' && req.method !== 'GET') {
      return res.status(403).json({
        success: false,
        error: 'Your account has been suspended'
      });
    }

    // Add user to request object
    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Not authorized to access this route'
    });
  }
};

/**
 * Middleware to protect routes that require authentication
 */
exports.protect = authenticate();

/**
 * Authentication that still admits a suspended account on writes.
 *
 * A suspension notice is delivered as a message, so the suspended user must be able to mark it read and
 * dismiss it — under `protect` those calls 403, leaving the badge stuck and the admin without a receipt.
 * Restricted to routes touching only the caller's own `message_states` row.
 */
exports.protectAllowSuspended = authenticate({ allowSuspended: true });

/**
 * Middleware to restrict routes to admin users
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
exports.admin = (req, res, next) => {
  if (req.user && req.user.account_type === 'admin') {
    next();
  } else {
    return res.status(403).json({
      success: false,
      error: 'Not authorized to access this route'
    });
  }
};
