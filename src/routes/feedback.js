const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  createThread,
  getThreads,
  getThread,
  addComment,
  updateComment,
  deleteComment,
  setStatus,
  setLocked,
  setVote,
  deleteThread,
  getUnreadCount,
  getMeta
} = require('../controllers/feedbackController');
const { protect, admin } = require('../middleware/auth');
const { clientIpKeyGenerator } = require('../utils/rateLimitKey');

const router = express.Router();

// Filing is the one route here a user can spam, and everything filed costs someone's attention to read.
// Reading, voting and commenting are left to the global limit — those are normal traffic on a thread.
//
// One budget across both branches: the cap is about attention, and a bug and a suggestion cost the same
// amount of it.
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
  message: { success: false, error: 'Too much filed at once. Try again later.' }
});

// Literal paths first, so neither is read as a thread ID.

// The types, categories, statuses and caps this server will accept
router.get('/meta', protect, getMeta);

// How many of the caller's threads have something new in them (badge), both branches together
router.get('/unread-count', protect, getUnreadCount);

// List threads — the caller's own, or everyone's with `?scope=all`; `?type=` picks the branch
router.get('/', protect, getThreads);

// File a bug report or a suggestion
router.post('/', protect, fileLimiter, createThread);

// Read one thread and its comments; reading marks it seen for anyone it badges
router.get('/:id', protect, getThread);

// Add a comment (a bug's reporter or an admin; anyone on an unlocked suggestion)
router.post('/:id/comments', protect, addComment);

// Edit a comment — its author only, admins included: moderation stops short of rewriting what
// somebody said. Deleting is the author's or an admin's, which is the lever for a thread gone bad.
router.put('/:id/comments/:commentId', protect, updateComment);
router.delete('/:id/comments/:commentId', protect, deleteComment);

// Vote for a suggestion, or take the vote back
router.put('/:id/vote', protect, setVote);

// Move a thread through triage (admin only)
router.put('/:id/status', protect, admin, setStatus);

// Close a thread to further replies, or reopen it (admin only)
router.put('/:id/lock', protect, admin, setLocked);

// Delete a thread and everything on it (admin only)
router.delete('/:id', protect, admin, deleteThread);

module.exports = router;
