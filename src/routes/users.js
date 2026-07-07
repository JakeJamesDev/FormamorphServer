const express = require('express');
const { getUsers, getMe, getMyWorlds, getUserWorlds, updateUserStatus } = require('../controllers/userController');
const { protect, admin } = require('../middleware/auth');

const router = express.Router();

// Get all users (admin only)
router.get('/', protect, admin, getUsers);

// Get current user profile
router.get('/me', protect, getMe);

// Get worlds created by current user
router.get('/me/worlds', protect, getMyWorlds);

// Get worlds created by a specific user
router.get('/:id/worlds', getUserWorlds);

// Update user status and account type (admin only)
router.put('/:id/status', protect, admin, updateUserStatus);

module.exports = router;
