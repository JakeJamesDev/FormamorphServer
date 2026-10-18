const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { suspensionExpired } = require('../config/suspension');

/**
 * Lift an account's suspension if its end has passed, and log the lift once.
 *
 * Shared by every path that reads an account's status, so no path refuses or hides an account past its
 * end. A row that is not due costs no query.
 *
 * @param {Object|null} user - A users row with `id`, `username`, `status` and `suspended_until`
 * @param {string} [now] - ISO instant, for tests
 * @returns {Object|null} The row as it now stands
 */
const liftExpiredSuspension = (user, now = new Date().toISOString()) => {
  if (!user || !suspensionExpired(user, now)) return user;

  if (User.liftSuspensionIfExpired(user.id, now)) {
    // The server lifted it, so the entry names no staff member.
    AuditLog.tryRecord({
      action: 'suspension_expired',
      actor: null,
      targetUser: user,
      targetKind: 'account',
      targetName: user.username,
      snippet: `Ended on ${user.suspended_until}`
    });
  }

  // Read back rather than assumed: another path may have lifted it, or staff may have changed it since.
  return { ...user, ...User.suspensionOf(user.id) };
};

module.exports = { liftExpiredSuspension };
