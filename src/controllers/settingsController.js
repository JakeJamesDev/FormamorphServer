const Setting = require('../models/Setting');
const { SETTINGS, isSetting } = require('../config/settings');

/** The same wording for a key this server does not have, whichever verb asked for it. */
const NO_SUCH_SETTING = 'No such setting';

/**
 * @desc    Read one server setting
 * @route   GET /api/settings/:key
 * @access  Private/Staff
 */
exports.getSetting = async (req, res, next) => {
  try {
    const { key } = req.params;
    if (!isSetting(key)) return res.status(404).json({ success: false, error: NO_SUCH_SETTING });

    res.status(200).json({
      success: true,
      key,
      data: Setting.get(key),
      updatedAt: Setting.updatedAt(key)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Write one server setting
 * @route   PUT /api/settings/:key
 * @access  Private/Staff
 */
exports.saveSetting = async (req, res, next) => {
  try {
    const { key } = req.params;
    if (!isSetting(key)) return res.status(404).json({ success: false, error: NO_SUCH_SETTING });

    const value = req.body ? req.body.value : undefined;
    const problem = SETTINGS[key].validate(value);
    if (problem) return res.status(400).json({ success: false, error: problem });

    res.status(200).json({ success: true, key, data: Setting.set(key, value) });
  } catch (error) {
    next(error);
  }
};
