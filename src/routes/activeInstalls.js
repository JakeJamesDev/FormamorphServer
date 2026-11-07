const express = require('express');
const rateLimit = require('express-rate-limit');
const { protect, admin } = require('../middleware/auth');
const { recordSend, getTotals } = require('../controllers/activeInstallController');
const { ACTIVE_INSTALLS_WINDOW_MS, ACTIVE_INSTALLS_LIMIT } = require('../config/activeInstalls');
const { clientIpKeyGenerator } = require('../utils/rateLimitKey');

const router = express.Router();

// In-memory counts keyed on the address; nothing about the caller reaches the database.
const sendLimiter = rateLimit({
  windowMs: ACTIVE_INSTALLS_WINDOW_MS,
  limit: ACTIVE_INSTALLS_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKeyGenerator,
  message: { success: false, error: 'Too many requests. Try again later.' }
});

router.post('/', sendLimiter, recordSend);
router.get('/', protect, admin, getTotals);

module.exports = router;
