const jwt = require('jsonwebtoken');
const db = require('../config/db');

/**
 * Middleware to protect routes that require authentication
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
exports.protect = async (req, res, next) => {
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
    const user = db.prepare('SELECT id, username, email, status, account_type FROM users WHERE id = ?').get(decoded.id);

    // Check if user exists
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized to access this route'
      });
    }

    // Check if user is suspended
    if (user.status === 'suspended' && req.method !== 'GET') {
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
