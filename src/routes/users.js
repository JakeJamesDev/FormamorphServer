const express = require('express');
const {
  getUsers, getMe, getMyWorlds, getUserWorlds, updateUserStatus,
  setMyAvatar, removeMyAvatar, removeUserAvatar, getUserProfile
} = require('../controllers/userController');
const { protect, admin, staff } = require('../middleware/auth');

const router = express.Router();

// Parsed per route rather than for the whole group: an avatar arrives as a base64 image, which does not
// fit the cap the rest of this router's bodies are held to. Only routes taking a body get a parser.
const smallJson = express.json({ limit: '100kb' });
const avatarJson = express.json({ limit: '2mb' });

// Get all users (staff only)
router.get('/', protect, staff, getUsers);

// Get current user profile
router.get('/me', protect, getMe);

// Get worlds created by current user
router.get('/me/worlds', protect, getMyWorlds);

// Set or remove the current user's profile image. Ahead of the `/:id` routes below, or `me` is read as
// somebody's ID.
router.put('/me/avatar', avatarJson, protect, setMyAvatar);
router.delete('/me/avatar', protect, removeMyAvatar);

// A user's public face: what a stranger sees when they click a name in a thread or on a listing
router.get('/:id/profile', getUserProfile);

// Get worlds created by a specific user
router.get('/:id/worlds', getUserWorlds);

// Remove a user's profile image (staff only)
router.delete('/:id/avatar', protect, staff, removeUserAvatar);

// Suspend or reinstate an account (staff only). The same route also changes what somebody *is*, which
// is an administrator's alone — enforced in the controller, since one body can carry both.
router.put('/:id/status', smallJson, protect, staff, updateUserStatus);

module.exports = router;
