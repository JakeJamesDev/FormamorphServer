const express = require('express');
const rateLimit = require('express-rate-limit');
const {
  createThread,
  getThreads,
  getThread,
  addComment,
  updateThread,
  updateComment,
  deleteComment,
  setStatus,
  setLocked,
  setVote,
  setAnswer,
  deleteThread,
  getUnreadCount,
  getMeta,
  searchUsers,
  searchThreads
} = require('../controllers/feedbackController');
const { protect, protectWhenSent, staff } = require('../middleware/auth');
const { clientIpKeyGenerator } = require('../utils/rateLimitKey');

const router = express.Router();

// Filing is the one route here a user can spam, and everything filed costs someone's attention to read.
// Reading, voting and commenting are left to the global limit — those are normal traffic on a thread.
//
// One budget across every branch: the cap is about attention, and each kind of thread costs the same
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

// The editor asks on every keystroke it debounces, so these get their own budget, per account.
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.user ? `user:${req.user.id}` : clientIpKeyGenerator(req)),
  message: { success: false, error: 'Too many searches. Try again shortly.' }
});

// Literal paths first, so neither is read as a thread ID.

// Autocomplete: usernames by prefix (a thread's participants first), threads by number or title
router.get('/search/users', protect, searchLimiter, searchUsers);
router.get('/search/threads', protect, searchLimiter, searchThreads);

// The types, categories, statuses and caps this server will accept; open to guests
router.get('/meta', protectWhenSent, getMeta);

// How many of the caller's threads have something new in them (badge), both branches together
router.get('/unread-count', protect, getUnreadCount);

// List threads — the caller's own, or everyone's with `?scope=all`; `?type=` picks the branch.
// A guest may list a Votable board with `scope=all` only.
router.get('/', protectWhenSent, getThreads);

// File a bug report, a suggestion or a question
router.post('/', protect, fileLimiter, createThread);

// Read one thread and its comments; reading marks it seen for anyone it badges.
// A guest may read a suggestion or a question; a bug answers 404.
router.get('/:id', protectWhenSent, getThread);

// Add a comment (a bug's reporter or an admin; anyone on an unlocked suggestion or question)
router.post('/:id/comments', protect, addComment);

// Edit a comment — its author only, admins included: moderation stops short of rewriting what
// somebody said. Deleting is the author's or an admin's, which is the lever for a thread gone bad.
router.put('/:id/comments/:commentId', protect, updateComment);
router.delete('/:id/comments/:commentId', protect, deleteComment);

// Vote for a suggestion or a question, or take the vote back
router.put('/:id/vote', protect, setVote);

// Accept, change or clear a question's answer (the asker or staff)
router.put('/:id/answer', protect, setAnswer);

// Rewrite a report. Who may change what is decided per field: a bug's words are the team's to make
// useful, a board post's stay its author's, and the filing (category, type) is triage either way.
router.put('/:id', protect, updateThread);

// Move a thread through triage (staff only)
router.put('/:id/status', protect, staff, setStatus);

// Close a thread to further replies, or reopen it (staff only)
router.put('/:id/lock', protect, staff, setLocked);

// Delete a thread and everything on it (staff only)
router.delete('/:id', protect, staff, deleteThread);

module.exports = router;
