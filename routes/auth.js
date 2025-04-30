const express = require('express');
const { check } = require('express-validator');
const { register, login, changePassword, getMe } = require('../controllers/authController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// Register user
router.post(
  '/register',
  [
    check('username', 'Username is required').not().isEmpty(),
    check('username', 'Username must be between 3 and 20 characters').isLength({ min: 3, max: 20 }),
    check('password', 'Password must be at least 6 characters').isLength({ min: 6 }),
    check('email', 'Please include a valid email').optional().isEmail()
  ],
  register
);

// Login user
router.post(
  '/login',
  [
    check('username', 'Username is required').not().isEmpty(),
    check('password', 'Password is required').exists()
  ],
  login
);

// Change password
router.post(
  '/change-password',
  [
    check('currentPassword', 'Current password is required').exists(),
    check('newPassword', 'New password must be at least 6 characters').isLength({ min: 6 })
  ],
  protect,
  changePassword
);

// Get current user
router.get('/me', protect, getMe);

module.exports = router;
