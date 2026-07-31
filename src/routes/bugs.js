const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  createReport,
  getReports,
  getReport,
  addComment,
  updateComment,
  deleteComment,
  setStatus,
  deleteReport,
  getUnreadCount,
  getMeta
} = require('../controllers/bugController');
const { protect, admin } = require('../middleware/auth');
const { clientIpKeyGenerator } = require('../utils/rateLimitKey');

const router = express.Router();

// Filing is the one route here a user can spam, and every report costs someone's attention to read.
// Reading and commenting are left to the global limit — those are normal traffic on a thread.
//
// Keyed on the account, not the address: filing needs a sign-in, so the account is the meaningful unit,
// and an IP key would throttle a whole household or campus as one. The IP is only the fallback for a
// request that somehow reaches here unauthenticated, which `protect` should already have refused.
const fileLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : clientIpKeyGenerator(req)),
  message: { success: false, error: 'Too many reports filed. Try again later.' }
});

// Literal paths first, so neither is read as a report ID.

// The categories, statuses and caps this server will accept
router.get('/meta', protect, getMeta);

// How many of the caller's threads have something new in them (badge)
router.get('/unread-count', protect, getUnreadCount);

// List reports — the caller's own, or everyone's for an admin with `?scope=all`
router.get('/', protect, getReports);

// File a report
router.post('/', protect, fileLimiter, createReport);

// Read one report and its thread (reporter or admin); reading marks it seen
router.get('/:id', protect, getReport);

// Add a comment to a thread (reporter or admin)
router.post('/:id/comments', protect, addComment);

// Edit or remove a comment (its author only — an admin's triage powers stop at their own words)
router.put('/:id/comments/:commentId', protect, updateComment);
router.delete('/:id/comments/:commentId', protect, deleteComment);

// Move a report through triage (admin only)
router.put('/:id/status', protect, admin, setStatus);

// Delete a report and its thread (admin only)
router.delete('/:id', protect, admin, deleteReport);

module.exports = router;
