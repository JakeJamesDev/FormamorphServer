const express = require('express');
const rateLimit = require('express-rate-limit');
const { submit, getQueue, getCount, accept, reject, exportAccepted } = require('../controllers/corefContributionController');
const { protect, staff } = require('../middleware/auth');

const router = express.Router();

// Keyed on the account: submitting needs a sign-in. One send per corrected turn, so an hour of play stays far below it.
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { success: false, error: 'Too many contributions at once. Try again later.' }
});

// Ahead of any `/:id` route.
router.get('/count', protect, staff, getCount);
router.get('/export', protect, staff, exportAccepted);

router.get('/', protect, staff, getQueue);
router.post('/', protect, submitLimiter, submit);
router.post('/:id/accept', protect, staff, accept);
router.post('/:id/reject', protect, staff, reject);

module.exports = router;
