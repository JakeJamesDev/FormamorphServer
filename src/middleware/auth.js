const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { isAdmin, isStaff } = require('../config/roles');

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
 * Authentication for a route that is open to everyone but behaves differently for a signed-in caller.
 *
 * Sets `req.user` when a valid token is present and leaves it undefined otherwise — never refusing the
 * request. The public catalog routes need this: a quarantined listing is hidden from the room but stays
 * visible to its author and to admins, which cannot be decided without knowing who is asking.
 *
 * A bad or expired token is treated as no token rather than as an error. These routes serve signed-out
 * visitors anyway, so failing them would turn a stale token into an outage for browsing.
 *
 * @param {Object} req - Express request object
 * @param {Object} _res - Express response object
 * @param {Function} next - Express next function
 */
exports.optionalAuth = async (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return next();

  try {
    const decoded = jwt.verify(header.split(' ')[1], process.env.JWT_SECRET);
    const user = db
      .prepare('SELECT id, username, email, status, account_type, created_at FROM users WHERE id = ?')
      .get(decoded.id);
    if (user) req.user = user;
  } catch {
    // Anonymous, exactly as if nothing had been sent.
  }

  return next();
};

/**
 * Middleware to restrict routes to admin users
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
exports.admin = (req, res, next) => {
  if (req.user && isAdmin(req.user)) {
    next();
  } else {
    return res.status(403).json({
      success: false,
      error: 'Not authorized to access this route'
    });
  }
};

/**
 * Middleware to restrict routes to accounts carrying moderation powers.
 *
 * The everyday moderation gate: dev, mod and admin alike. `admin` stays for the few things that are
 * genuinely the owner's — changing what somebody is, writing the site's policies, and speaking to
 * everyone at once. Refuses with the same wording, so a probe learns nothing about which gate it hit.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
exports.staff = (req, res, next) => {
  if (req.user && isStaff(req.user)) {
    next();
  } else {
    return res.status(403).json({
      success: false,
      error: 'Not authorized to access this route'
    });
  }
};
