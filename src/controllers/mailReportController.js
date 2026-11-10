const { buildMailReport } = require('../utils/mailHealth');
const MailLog = require('../models/MailLog');

/**
 * @desc    Mail per UTC day, the 7-day bounce and complaint rates, and the last SES account read
 * @route   GET /api/mail/report?days=N
 * @access  Admin
 */
exports.getMailReport = (req, res, next) => {
  try {
    const days = req.query.days === undefined ? 30 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > MailLog.RETENTION_DAYS) {
      return res.status(400).json({ success: false, error: `days must be a whole number from 1 to ${MailLog.RETENTION_DAYS}` });
    }

    return res.status(200).json({ success: true, data: buildMailReport(days) });
  } catch (error) {
    return next(error);
  }
};
