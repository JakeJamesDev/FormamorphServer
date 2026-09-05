const express = require('express');
const rateLimit = require('express-rate-limit');
const { check } = require('express-validator');
const { register, login, getMe, changePassword, requestAccountDeletion, verifyEmail } = require('../controllers/authController');
const { protect, protectBeforePolicy, protectDeletionRequest } = require('../middleware/auth');
const { clientIpKeyGenerator } = require('../utils/rateLimitKey');

const router = express.Router();

// Tight limiter for credential endpoints — blunts brute-force / credential stuffing
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientIpKeyGenerator,
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
    // `values: 'falsy'` so a form that posts an empty box reads as no address rather than a bad one.
    check('email', 'Please include a valid email').optional({ values: 'falsy' }).isEmail()
  ],
  register
);

// Prove an email address. Public, because the link is opened wherever the mail was read and that is
// rarely the device holding the session. Under the credential limiter: it takes a token, so it is a
// place to guess one.
router.post('/verify-email', authLimiter, verifyEmail);

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

// Change password. Exempt from the Privacy Policy gate: securing an account you suspect is compromised
// must not wait on reading a policy.
router.post(
  '/change-password',
  authLimiter,
  [
    check('currentPassword', 'Current password is required').not().isEmpty(),
    check('newPassword', 'New password must be at least 6 characters long').isLength({ min: 6 })
  ],
  protectBeforePolicy,
  changePassword
);

// Ask for this account to be erased. Under the credential limiter with the rest: it takes a password, so
// it is a place to guess one.
router.post('/delete-account', authLimiter, protectDeletionRequest, requestAccountDeletion);

module.exports = router;
