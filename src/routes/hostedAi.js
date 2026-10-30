const express = require('express');
const { protect, staff, admin } = require('../middleware/auth');
const { admit, routeError, proxy, getPause, liftPause } = require('../controllers/hostedAiController');
const { getState, acknowledgeWarning } = require('../controllers/hostedStateController');
const adminRoutes = require('./hostedAiAdmin');
const { HOSTED_BODY_LIMIT } = require('../config/hostedAi');

const router = express.Router();

router.get('/state', protect, getState);
router.post('/warnings/:threshold/ack', protect, acknowledgeWarning);
router.use('/admin', adminRoutes);

// Admission runs before the body is parsed, so a refused account never costs a large parse.
router.post(
  '/chat/completions',
  protect,
  admit,
  express.json({ limit: HOSTED_BODY_LIMIT }),
  proxy,
  routeError
);

// The day's pause: staff read it, only an admin lifts it.
router.get('/pause', protect, staff, getPause);
router.post('/pause/lift', protect, admin, liftPause);

module.exports = router;
