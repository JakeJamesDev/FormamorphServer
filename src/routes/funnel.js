const express = require('express');
const rateLimit = require('express-rate-limit');
const { protect, admin } = require('../middleware/auth');
const { recordStep, getTotals } = require('../controllers/funnelController');
const { FUNNEL_WINDOW_MS, FUNNEL_LIMIT } = require('../config/funnel');
const { clientIpKeyGenerator } = require('../utils/rateLimitKey');

const router = express.Router();

// In-memory counts keyed on the address; nothing about the caller reaches the database.
const funnelLimiter = rateLimit({
  windowMs: FUNNEL_WINDOW_MS,
  limit: FUNNEL_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKeyGenerator,
  message: { success: false, error: 'Too many requests. Try again later.' }
});

router.post('/:step', funnelLimiter, recordStep);
router.get('/', protect, admin, getTotals);

module.exports = router;
