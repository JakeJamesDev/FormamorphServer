const { buildStorageReport } = require('../utils/storageCheck');
const { REPORT_DEFAULT_DAYS, REPORT_MAX_DAYS } = require('../config/storage');

/**
 * @desc    Disk fullness, directory sizes, whether a vacuum fits, storage and downloads per UTC day, and the days until each disk is full
 * @route   GET /api/storage/report?days=N
 * @access  Admin
 */
exports.getStorageReport = async (req, res, next) => {
  try {
    const days = req.query.days === undefined ? REPORT_DEFAULT_DAYS : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > REPORT_MAX_DAYS) {
      return res.status(400).json({ success: false, error: `days must be a whole number from 1 to ${REPORT_MAX_DAYS}` });
    }

    return res.status(200).json({ success: true, data: await buildStorageReport(days) });
  } catch (error) {
    return next(error);
  }
};
