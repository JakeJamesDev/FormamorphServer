const ActiveInstall = require('../models/ActiveInstall');
const Setting = require('../models/Setting');
const { NO_INSTALL, installIdFrom } = require('../config/anonymousLikes');
const { recordedVersion } = require('../config/clientVersion');
const { ACTIVE_INSTALLS, NO_CLIENT, REPORT_DAYS_DEFAULT, REPORT_DAYS_MAX } = require('../config/activeInstalls');
const { DAY_MS, utcDay } = require('../config/time');

/** The biggest share first, then by name, so a response reads the same every time. */
const byCount = (a, b) => b.count - a.count || a.platform.localeCompare(b.platform) || a.version.localeCompare(b.version);

const period = (key, name, breakdown = []) => ({
  [key]: name,
  total: breakdown.reduce((sum, row) => sum + row.count, 0),
  breakdown: [...breakdown].sort(byCount)
});

/**
 * @desc    Count this Install as active today
 * @route   POST /api/active-installs
 * @access  Public
 */
exports.recordSend = (req, res, next) => {
  try {
    const installId = installIdFrom(req);
    if (!installId) return res.status(400).json(NO_INSTALL);

    const version = recordedVersion(req.client);
    if (!version) return res.status(400).json(NO_CLIENT);

    if (Setting.get(ACTIVE_INSTALLS) === true) {
      ActiveInstall.record(utcDay(new Date()), installId, req.client.platform, version);
    }

    res.status(204).end();
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Daily and monthly active installs, newest first
 * @route   GET /api/active-installs?days=N
 * @access  Private/Admin
 */
exports.getTotals = (req, res, next) => {
  try {
    const dayCount = req.query.days === undefined ? REPORT_DAYS_DEFAULT : Number(req.query.days);
    if (!Number.isInteger(dayCount) || dayCount < 1 || dayCount > REPORT_DAYS_MAX) {
      return res.status(400).json({ success: false, error: `days must be a whole number from 1 to ${REPORT_DAYS_MAX}` });
    }

    const today = Date.parse(utcDay(new Date()));
    const dayNames = Array.from({ length: dayCount }, (_, index) => utcDay(new Date(today - index * DAY_MS)));
    const dayCounts = ActiveInstall.daysSince(dayNames[dayCount - 1]);
    const days = dayNames.map((day) => period('day', day, dayCounts.get(day)));

    const months = [...ActiveInstall.months()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([month, breakdown]) => period('month', month, breakdown));

    res.status(200).json({ success: true, data: { days, months } });
  } catch (error) {
    next(error);
  }
};
