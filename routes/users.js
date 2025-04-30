const express = require('express');
const { getProfile, getUserWorlds, getMyWorlds, updateUserStatus, getUsers } = require('../controllers/userController');
const { protect } = require('../middleware/auth');
const { check } = require('express-validator');

const router = express.Router();

// Get current user profile
router.get('/me', protect, getProfile);

// Get worlds created by current user
router.get('/me/worlds', protect, getMyWorlds);

// Get worlds created by a specific user
router.get('/:id/worlds', getUserWorlds);

// Get all users (admin only)
router.get('/', protect, getUsers);

// Update user status and account type (admin only)
router.put('/:id/status', 
  protect,
  [
    check('status')
      .optional()
      .isIn(['normal', 'flagged', 'suspended'])
      .withMessage('Status must be normal, flagged, or suspended'),
    check('accountType')
      .optional()
      .isIn(['normal', 'admin'])
      .withMessage('Account type must be normal or admin')
  ],
  updateUserStatus
);

module.exports = router;
