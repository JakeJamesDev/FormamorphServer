const Setting = require('../models/Setting');
const HostedGrant = require('../models/HostedGrant');
const { HOSTED_AI, warnThresholdsOf } = require('../config/hostedAi');
const { activeConfig } = require('./hostedAiController');
const { entitlement, hostedState, monthKey } = require('../utils/hostedState');

/**
 * @desc    The signed-in account's Formamorph AI state: tier, window, allowance used and warnings seen
 * @route   GET /api/hosted-ai/state
 * @access  Private
 */
exports.getState = (req, res, next) => {
  try {
    const now = new Date();
    const owned = entitlement(req.user.id, now);
    const config = owned ? activeConfig(owned.tier) : null;

    res.status(200).json({ success: true, data: hostedState(req.user, config, owned, now) });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Acknowledge a usage warning for this month, so no device shows it again
 * @route   POST /api/hosted-ai/warnings/:threshold/ack
 * @access  Private
 */
exports.acknowledgeWarning = (req, res, next) => {
  try {
    const thresholds = warnThresholdsOf(Setting.get(HOSTED_AI));
    const threshold = Number(req.params.threshold);
    if (!Number.isInteger(threshold) || !thresholds.includes(threshold)) {
      return res.status(400).json({ success: false, error: 'That is not a warning threshold' });
    }

    const month = monthKey(new Date());
    HostedGrant.acknowledge(req.user.id, month, threshold);

    return res.status(200).json({ success: true, data: { acknowledged: HostedGrant.acknowledged(req.user.id, month) } });
  } catch (error) {
    return next(error);
  }
};
