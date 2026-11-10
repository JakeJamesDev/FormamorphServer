const { buildStorageReport } = require('../utils/storageCheck');

/**
 * @desc    Disk fullness, the size of each upload directory, the database and the local backups, and whether a vacuum fits
 * @route   GET /api/storage/report
 * @access  Admin
 */
exports.getStorageReport = async (req, res, next) => {
  try {
    return res.status(200).json({ success: true, data: await buildStorageReport() });
  } catch (error) {
    return next(error);
  }
};
