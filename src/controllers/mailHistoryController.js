const User = require('../models/User');
const MailLog = require('../models/MailLog');
const AuditLog = require('../models/AuditLog');
const { STAFF_PROTECTED, canModerate } = require('../config/roles');
const { removeFromSuppressionList } = require('../utils/mail');

const NOT_FOUND = { success: false, error: 'User not found' };

const PROVIDER_FAILED = {
  success: false,
  code: 'MAIL_PROVIDER_FAILED',
  error: 'Amazon SES did not take the address off its suppression list. The bounce is not cleared'
};

/** The account's marker as staff read it. */
const markerOf = (user) => ({ emailMarker: user.email_marker ?? null, emailMarkedAt: user.email_marked_at ?? null });

/**
 * Any staff member may read any account's history, as with linked accounts. No address and no SES message
 * id leave the server here.
 *
 * @desc    One account's mail, newest first, and its address marker
 * @route   GET /api/users/:id/mail-history
 * @access  Private/Staff
 */
exports.getMailHistory = (req, res, next) => {
  try {
    const user = User.findById(req.params.id);
    if (!user) return res.status(404).json(NOT_FOUND);

    return res.status(200).json({
      success: true,
      data: {
        ...markerOf(user),
        mails: MailLog.forUser(user.id)
      }
    });
  } catch (error) {
    return next(error);
  }
};

/**
 * SES first: when it fails, the marker stays, so staff never tell a user mail works when SES still
 * suppresses it. Verification stays removed; the user verifies the address again.
 *
 * @desc    Take an account's address off the SES suppression list and remove its marker
 * @route   DELETE /api/users/:id/email-marker
 * @access  Private/Staff
 */
exports.clearEmailMarker = async (req, res, next) => {
  try {
    const user = User.findById(req.params.id);
    if (!user) return res.status(404).json(NOT_FOUND);
    if (!canModerate(req.user, user)) return res.status(403).json({ success: false, error: STAFF_PROTECTED });

    if (!user.email_marker) return res.status(200).json({ success: true, data: { cleared: false } });

    try {
      await removeFromSuppressionList(user.email);
    } catch (error) {
      console.error(error.message);
      return res.status(502).json(PROVIDER_FAILED);
    }

    const cleared = User.clearEmailMarker(user.id);
    if (cleared) {
      AuditLog.tryRecord({
        action: 'email_marker_cleared',
        actor: req.user,
        targetUser: user,
        targetKind: 'account',
        targetName: user.username,
        snippet: user.email_marker
      });
    }

    return res.status(200).json({ success: true, data: { cleared } });
  } catch (error) {
    return next(error);
  }
};
