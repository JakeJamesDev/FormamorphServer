const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  getMeta,
  submitReport,
  getQueue,
  getOpenCount,
  resolveTargetReports
} = require('../controllers/reportController');
const { protect, staff } = require('../middleware/auth');
const { clientIpKeyGenerator } = require('../utils/rateLimitKey');

const router = express.Router();

// Filing is the one route here somebody can flood, and everything filed costs staff attention to read.
// The one-open-per-target rule is the real flood control — this is the backstop for somebody working
// through a list of targets rather than hammering one.
//
// Keyed on the account, not the address: reporting needs a sign-in, so the account is the meaningful
// unit, and an IP key would throttle a whole household or campus as one.
const fileLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : clientIpKeyGenerator(req)),
  message: { success: false, error: 'Too many reports at once. Try again later.' }
});

// The categories and caps this server accepts. Also how a client detects the feature at all: a server
// that predates it 404s here, and every report control stays off screen.
router.get('/meta', protect, getMeta);

// How many targets have an open report on them (staff badge)
router.get('/open-count', protect, staff, getOpenCount);

// The open queue, grouped by target
router.get('/', protect, staff, getQueue);

// File a report
router.post('/', protect, fileLimiter, submitReport);

// Close every open report on one target, with an outcome and an optional note. Per target, never per
// report: staff judge the content once, and everyone who reported it gets that answer.
router.post('/resolve', protect, staff, resolveTargetReports);

module.exports = router;
