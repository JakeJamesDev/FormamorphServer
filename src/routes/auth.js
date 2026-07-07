const express = require('express');
const rateLimit = require('express-rate-limit');
const { check } = require('express-validator');
const { register, login, getMe, changePassword } = require('../controllers/authController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// Tight limiter for credential endpoints — blunts brute-force / credential stuffing
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts, please try again later' }
});

// Register user
router.post(
  '/register',
  authLimiter,
  [
    check('username', 'Username is required').not().isEmpty(),
    check('username', 'Username must be between 3 and 20 characters').isLength({ min: 3, max: 20 }),
    check('password', 'Password must be at least 6 characters long').isLength({ min: 6 }),
    check('email', 'Please include a valid email').optional().isEmail()
  ],
  register
);

// Login user
router.post(
  '/login',
  authLimiter,
  [
    check('username', 'Username is required').not().isEmpty(),
    check('password', 'Password is required').exists()
  ],
  login
);

// Get current user
router.get('/me', protect, getMe);

// Change password
router.post(
  '/change-password',
  authLimiter,
  [
    check('currentPassword', 'Current password is required').not().isEmpty(),
    check('newPassword', 'New password must be at least 6 characters long').isLength({ min: 6 })
  ],
  protect,
  changePassword
);

module.exports = router;
