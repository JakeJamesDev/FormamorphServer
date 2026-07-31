const express = require('express');
const {
  getInbox,
  getUnreadCount,
  markRead,
  dismiss,
  sendMessage,
  getSent,
  editMessage,
  recallMessage
} = require('../controllers/messageController');
const { protect, protectAllowSuspended, admin } = require('../middleware/auth');

const router = express.Router();

// Literal paths first, so `sent` and `unread-count` are never read as a message ID.

// Get the current user's unread count (badge)
router.get('/unread-count', protect, getUnreadCount);

// List sent messages (admin only)
router.get('/sent', protect, admin, getSent);

// Edit a sent message (admin only)
router.put('/sent/:id', protect, admin, editMessage);

// Recall a sent message (admin only)
router.delete('/sent/:id', protect, admin, recallMessage);

// Get the current user's inbox
router.get('/', protect, getInbox);

// Send a message (admin only)
router.post('/', protect, admin, sendMessage);

// Mark a message read. A suspension notice is delivered this way, so its recipient must be able to
// clear it even while suspended; this writes nothing but their own state row.
router.post('/:id/read', protectAllowSuspended, markRead);

// Dismiss a message from the current user's inbox (suspended accounts included, same reasoning)
router.delete('/:id', protectAllowSuspended, dismiss);

module.exports = router;
