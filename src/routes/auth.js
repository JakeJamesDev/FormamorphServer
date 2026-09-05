const express = require('express');
const rateLimit = require('express-rate-limit');
const { check } = require('express-validator');
const { register, login, getMe, changePassword, requestAccountDeletion, verifyEmail, setEmail, resendVerification, requestPasswordReset, resetPassword } = require('../controllers/authController');
const { protect, protectBeforePolicy, protectDeletionRequest } = require('../middleware/auth');
const { clientIpKeyGenerator, resetAccountKeyGenerator } = require('../utils/rateLimitKey');
const { MAIL_LIMIT, MAIL_WINDOW_MS, RESET_LIMIT, RESET_WINDOW_MS } = require('../config/mail');
const { PASSWORD_MIN_LENGTH, PASSWORD_RULE } = require('../config/password');

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

// A second budget under the one above, on the mail an account causes rather than on requests from one
// address. Rotating IPs defeats the limiter above and does nothing to this one. See `config/mail` for
// why the account and not the mailed address is the thing being counted.
//
// Only mounted after `protect`, which is what makes `req.user` available to key on. Refusals are
// refunded, so mistyping an address five times does not cost somebody the mail they were trying to get.
const mailLimiter = rateLimit({
  windowMs: MAIL_WINDOW_MS,
  limit: MAIL_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { success: false, error: 'Too many verification mails asked for. Try again later.' }
});

// The second budget on the reset request, under the per-address one above it. It counts the name the
// request typed rather than the account that name resolves to — see `config/mail` for why. Refusals are
// refunded, so a form submitted blank does not spend a budget.
const resetRequestLimiter = rateLimit({
  windowMs: RESET_WINDOW_MS,
  limit: RESET_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true,
  keyGenerator: resetAccountKeyGenerator,
  message: { success: false, error: 'Too many reset requests. Try again later.' }
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

// Set or replace the address on the signed-in account. No `optional()` here, unlike register: reaching
// this route is asking for an address to be written, and an empty box is a mistake rather than a choice.
// Removing an address is not offered at all.
router.post(
  '/email',
  authLimiter,
  protect,
  [check('email', 'Please include a valid email').isEmail()],
  mailLimiter,
  setEmail
);

// Ask for the verification mail again, for a mail that never arrived or was lost.
router.post('/resend-verification', authLimiter, protect, mailLimiter, resendVerification);

// Ask for a reset link. Public and unauthenticated: somebody who can still sign in has change-password,
// and somebody who cannot is the only person this route is for. `authLimiter` is the per-address budget
// and `resetRequestLimiter` the per-name one.
router.post(
  '/request-password-reset',
  authLimiter,
  resetRequestLimiter,
  [check('account', 'Enter your email address or username').trim().not().isEmpty()],
  requestPasswordReset
);

// Set a new password with the token out of the mail. Public, because the link is opened wherever the
// mail was read. Under the credential limiter: it takes a token, so it is a place to guess one.
router.post(
  '/reset-password',
  authLimiter,
  [check('newPassword', PASSWORD_RULE).isLength({ min: PASSWORD_MIN_LENGTH })],
  resetPassword
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

// Change password. Exempt from the Privacy Policy gate: securing an account you suspect is compromised
// must not wait on reading a policy.
router.post(
  '/change-password',
  authLimiter,
  [
    check('currentPassword', 'Current password is required').not().isEmpty(),
    check('newPassword', PASSWORD_RULE).isLength({ min: PASSWORD_MIN_LENGTH })
  ],
  protectBeforePolicy,
  changePassword
);

// Ask for this account to be erased. Under the credential limiter with the rest: it takes a password, so
// it is a place to guess one.
router.post('/delete-account', authLimiter, protectDeletionRequest, requestAccountDeletion);

module.exports = router;
