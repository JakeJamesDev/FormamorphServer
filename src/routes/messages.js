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
const { protect, protectAllowSuspended, staff } = require('../middleware/auth');

const router = express.Router();

// Literal paths first, so `sent` and `unread-count` are never read as a message ID.

// Get the current user's unread count (badge)
router.get('/unread-count', protect, getUnreadCount);

// List sent messages (staff only) — also what the user table's History button reads
router.get('/sent', protect, staff, getSent);

// Edit a sent message (its sender, or any administrator)
router.put('/sent/:id', protect, staff, editMessage);

// Recall a sent message (its sender, or any administrator)
router.delete('/sent/:id', protect, staff, recallMessage);

// Get the current user's inbox
router.get('/', protect, getInbox);

// Send a message (staff for a direct notice; a broadcast is an administrator's, checked in the controller)
router.post('/', protect, staff, sendMessage);

// Mark a message read. A suspension notice is delivered this way, so its recipient must be able to
// clear it even while suspended; this writes nothing but their own state row.
router.post('/:id/read', protectAllowSuspended, markRead);

// Dismiss a message from the current user's inbox (suspended accounts included, same reasoning)
router.delete('/:id', protectAllowSuspended, dismiss);

module.exports = router;
