const FunnelTotal = require('../models/FunnelTotal');
const { FUNNEL_STEPS } = require('../config/funnel');

/**
 * @desc    Count one player reaching a funnel step today
 * @route   POST /api/funnel/:step
 * @access  Public
 */
exports.recordStep = (req, res, next) => {
  try {
    if (!FUNNEL_STEPS.includes(req.params.step)) {
      return res.status(400).json({ success: false, error: 'Unknown step' });
    }

    FunnelTotal.increment(new Date().toISOString().slice(0, 10), req.params.step);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    The totals by day, newest first
 * @route   GET /api/funnel
 * @access  Private/Admin
 */
exports.getTotals = (req, res, next) => {
  try {
    const days = new Map();
    for (const { day, step, count } of FunnelTotal.all()) {
      if (!days.has(day)) days.set(day, { day, steps: Object.fromEntries(FUNNEL_STEPS.map((name) => [name, 0])) });
      days.get(day).steps[step] = count;
    }

    res.status(200).json({ success: true, data: { days: [...days.values()] } });
  } catch (error) {
    next(error);
  }
};
