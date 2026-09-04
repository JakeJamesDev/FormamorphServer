const jwt = require('jsonwebtoken');
const db = require('../config/db');
const { isAdmin, isStaff } = require('../config/roles');
const { privacyRefusal } = require('./policy');

/**
 * Whether a token was minted under the account's current session generation.
 *
 * A token predating the `tv` claim reads as generation 0, which every un-bumped row is — so adding this
 * check signed nobody out. The first bump on an account is what retires those.
 *
 * @param {Object} decoded - The verified token payload
 * @param {Object} user - The user row
 * @returns {boolean} Whether the token is still current
 */
const sameGeneration = (decoded, user) => (decoded.tv || 0) === (user.token_version || 0);

/**
 * Build an authentication middleware.
 *
 * @param {Object} [options]
 *   `allowSuspended` — when true, a suspended account may also make write requests. Only for routes that
 *   write nothing but the caller's own read/dismiss state.
 *   `allowUnacceptedPolicy` — when true, the Privacy Policy gate is not applied. Only for the routes a
 *   refused account needs to stop being refused.
 * @returns {Function} Express middleware
 */
const authenticate = ({ allowSuspended = false, allowUnacceptedPolicy = false } = {}) => async (req, res, next) => {
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
    const user = db.prepare('SELECT id, username, email, status, account_type, token_version, created_at FROM users WHERE id = ?').get(decoded.id);

    // Check if user exists
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized to access this route'
      });
    }

    // Refuse a token from a retired generation. Changing a password or suspending an account bumps the
    // row, which is what makes those actions reach sessions already signed in somewhere else.
    if (!sameGeneration(decoded, user)) {
      return res.status(401).json({
        success: false,
        error: 'Not authorized to access this route'
      });
    }

    // Add user to request object
    req.user = user;

    // The Privacy Policy answers before the suspension does. It applies to every account, suspended
    // included, and a suspended user who has not accepted would otherwise be sent to the wrong dialog on
    // a write and refused nothing at all on a read.
    const refusal = allowUnacceptedPolicy ? null : privacyRefusal(user);
    if (refusal) {
      return res.status(403).json(refusal);
    }

    // Check if user is suspended
    if (!allowSuspended && user.status === 'suspended' && req.method !== 'GET') {
      return res.status(403).json({
        success: false,
        error: 'Your account has been suspended'
      });
    }

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
 * Authentication for the routes that must work before the Privacy Policy has been accepted.
 *
 * The gate refuses everything else, so a route it applies to cannot be part of getting past it. That is
 * the whole exemption list: changing a password, and the policy routes — reading the policy, answering it,
 * and the admin screens that authored it, since the admin who switches it on has not accepted it either.
 * Registration and login authenticate nobody and so never reach the gate at all.
 */
exports.protectBeforePolicy = authenticate({ allowUnacceptedPolicy: true });

/**
 * Authentication for asking to have the account erased.
 *
 * Both exemptions, for two different reasons. The policy prompt's third button is Delete my account, so the
 * gate cannot stand in front of the one route that gets somebody out from behind it. And a suspended
 * account has to reach the handler to be told where its own path is — refused here, it would get the
 * generic suspension message instead of being pointed at Feedback.
 */
exports.protectDeletionRequest = authenticate({ allowSuspended: true, allowUnacceptedPolicy: true });

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
 * A caller who has not accepted the Privacy Policy is served as a visitor: browsing needs no account, but
 * the account's privileges, an author's view of its own quarantined listing among them, wait on the answer.
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
      .prepare('SELECT id, username, email, status, account_type, token_version, created_at FROM users WHERE id = ?')
      .get(decoded.id);
    // A retired token is treated as no token, exactly as a bad one is: these routes serve signed-out
    // visitors anyway, so the caller simply stops being recognized.
    if (user && sameGeneration(decoded, user)) req.user = user;
  } catch {
    // Anonymous, exactly as if nothing had been sent.
  }

  if (req.user && privacyRefusal(req.user)) delete req.user;

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
