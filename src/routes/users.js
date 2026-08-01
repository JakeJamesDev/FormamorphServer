const express = require('express');
const {
  getUsers, getMe, getMyWorlds, getUserWorlds, updateUserStatus,
  setMyAvatar, removeMyAvatar, removeUserAvatar
} = require('../controllers/userController');
const { protect, admin } = require('../middleware/auth');

const router = express.Router();

// Parsed per route rather than for the whole group: an avatar arrives as a base64 image, which does not
// fit the cap the rest of this router's bodies are held to. Only routes taking a body get a parser.
const smallJson = express.json({ limit: '100kb' });
const avatarJson = express.json({ limit: '2mb' });

// Get all users (admin only)
router.get('/', protect, admin, getUsers);

// Get current user profile
router.get('/me', protect, getMe);

// Get worlds created by current user
router.get('/me/worlds', protect, getMyWorlds);

// Set or remove the current user's profile image. Ahead of the `/:id` routes below, or `me` is read as
// somebody's ID.
router.put('/me/avatar', avatarJson, protect, setMyAvatar);
router.delete('/me/avatar', protect, removeMyAvatar);

// Get worlds created by a specific user
router.get('/:id/worlds', getUserWorlds);

// Remove a user's profile image (admin only)
router.delete('/:id/avatar', protect, admin, removeUserAvatar);

// Update user status and account type (admin only)
router.put('/:id/status', smallJson, protect, admin, updateUserStatus);

module.exports = router;
