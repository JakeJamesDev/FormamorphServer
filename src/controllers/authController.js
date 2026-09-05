const User = require('../models/User');
const AccountToken = require('../models/AccountToken');
const AuditLog = require('../models/AuditLog');
const { avatarUrlFor } = require('../utils/avatarUrl');
const generateToken = require('../utils/generateToken');
const { recordSignal } = require('../utils/recordSignal');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/accountMail');
const { addressGiven, foldedAddress } = require('../utils/emailAddress');
const { erasureDue, SYSTEM_STATUS } = require('../config/accountDeletion');
const { VERIFY, RESET } = require('../config/accountTokens');
const { PASSWORD_MIN_LENGTH, PASSWORD_RULE } = require('../config/password');
const { validationResult } = require('express-validator');

/**
 * The account, as its own owner is told it.
 *
 * Register, login and me all answer with this. Written once because the three had already drifted: a
 * field added to one of them is a field the client cannot rely on from the other two, and which of the
 * three a session came through is not something a client should have to remember.
 *
 * @param {Object} user - A users row
 * @returns {Object} The fields an account's owner sees about themselves
 */
const accountSummary = (user) => ({
  id: user.id,
  username: user.username,
  email: user.email,
  emailVerified: Boolean(user.email_verified_at),
  status: user.status,
  accountType: user.account_type,
  avatarUrl: avatarUrlFor(user.avatar_file)
});

/**
 * Mail the verification link, and say whether it went.
 *
 * Delivery is somebody else's service, so an outage there is not the caller's fault and must never cost
 * them the thing they actually did — the address is on file either way. The outcome comes back instead
 * of being thrown, so a route that has one can tell the client to offer another try.
 *
 * @param {Object} params - Who to write to
 * @param {string} params.userId - The account whose address is being verified
 * @param {string} params.email - The address the link goes to
 * @returns {Promise<boolean>} Whether the transport took the message
 */
const tryVerificationMail = async ({ userId, email }) => {
  try {
    await sendVerificationEmail({ userId, email });
    return true;
  } catch (error) {
    console.error(`Could not send the verification mail for ${userId}:`, error.message);
    return false;
  }
};

/**
 * Mail the reset link, and swallow whatever delivery does.
 *
 * Nothing is reported back because nothing may be: the caller has already answered, and it answered the
 * same way for an account that does not exist. A failure that reached the client would be the one thing
 * in the exchange that told an outsider a real account was named.
 *
 * @param {Object} params - Who to write to
 * @param {string} params.userId - The account the link resets
 * @param {string} params.email - The verified address the link goes to
 * @returns {Promise<void>} Resolves once the transport has taken the message or refused it
 */
const tryResetMail = async ({ userId, email }) => {
  try {
    await sendPasswordResetEmail({ userId, email });
  } catch (error) {
    console.error(`Could not send the reset mail for ${userId}:`, error.message);
  }
};

/**
 * @desc    Register a new user
 * @route   POST /api/auth/register
 * @access  Public
 */
exports.register = async (req, res, next) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const { username, password, email } = req.body;
    const address = addressGiven(email);

    // Create user. Both a taken name and a taken address are refused by the unique constraint rather than
    // by a lookup first: a lookup would still have to be backed by this branch, because two registrations
    // racing for one name or one address both find it free, and then two places decide what "taken"
    // means. Which of the two collided is read off the column SQLite names.
    //
    // The two refusals are separate because the fixes are: pick another name, or recover the account that
    // already holds the address. One shared message would send half the people who hit this down the
    // wrong one. The name keeps its original 400 and no code, because clients already read it that way.
    let user;
    try {
      user = await User.create({ username, password, email: address });
    } catch (error) {
      if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;

      if (/users\.email/.test(error.message)) {
        return res.status(409).json({
          success: false,
          code: 'EMAIL_TAKEN',
          error: 'That email address is already registered'
        });
      }

      return res.status(400).json({
        success: false,
        error: 'Username already exists'
      });
    }

    // Unverified, and the account is already usable — verification is what password reset needs, not what
    // signing in needs. The outcome is dropped here rather than reported: what registering answers with
    // is the session and the account, and the player can ask for the mail again from the account page.
    if (address) await tryVerificationMail({ userId: user.id, email: address });

    // The account exists now, so this is the first place a Signal can name it. Four accounts made from one
    // address in two minutes is the pattern this whole table is here to make visible.
    recordSignal(req, user.id, 'signup');

    // Generate token
    const token = generateToken(user);

    res.status(201).json({
      success: true,
      token,
      user: accountSummary(user)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Login user
 * @route   POST /api/auth/login
 * @access  Public
 */
exports.login = async (req, res, next) => {
  try {
    const { username, password } = req.body;

    // Check if user exists
    const user = User.findByUsername(username);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // The reserved `[deleted user]` row is an owner for other people's work, never a session. Refused
    // before the password is compared, and with the same wording as a wrong one, so nobody can tell the
    // reserved name from a name nobody has taken.
    if (user.status === SYSTEM_STATUS) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Check if password matches
    const isMatch = await User.matchPassword(password, user.password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // A suspended account may sign in. Suspension is enforced per request by `protect`, which turns away
    // every non-GET — so signing in grants reading only, the same as the public browse routes already
    // allow when signed out. Refusing the login instead denied them nothing but the sight of their own
    // account, including the message explaining the suspension. The response carries `status` so the
    // client can show the account as suspended rather than as an ordinary session.
    //
    // The credentials have checked out, so the account really is acting from here. This is also the only
    // event an account that predates the table can acquire without doing anything else.
    recordSignal(req, user.id, 'login');

    // Signing in is how a pending deletion is taken back, and the only way there is. Nothing was hidden
    // while the request stood, so clearing the stamp restores the account whole. The flag goes back so the
    // client can say so — the user may not remember asking.
    let deletionCanceled = false;
    if (user.deletion_requested_at) deletionCanceled = User.cancelDeletion(user.id);

    if (deletionCanceled) {
      AuditLog.tryRecord({
        action: 'account_deletion_canceled',
        actor: user,
        targetKind: 'account',
        targetName: user.username
      });
    }

    const token = generateToken(user);

    res.status(200).json({
      success: true,
      token,
      ...(deletionCanceled ? { deletionCanceled: true } : {}),
      user: accountSummary(user)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Ask for this account to be erased, after a grace period
 * @route   POST /api/auth/delete-account
 * @access  Private (suspended accounts and unaccepted policies included — see `protectDeletionRequest`)
 */
exports.requestAccountDeletion = async (req, res, next) => {
  try {
    const { password, deleteContent } = req.body;

    // A suspension is evidence about somebody, so the person it is about does not get to erase it. They
    // still have a way out; the message is where it is.
    if (req.user.status === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'A suspended account cannot be deleted from here. Ask through Feedback and the team will handle it.'
      });
    }

    // The password, not the session: a stolen token must not be able to end the account it stole. Asked
    // before the body is judged, so somebody who cannot prove the account is theirs learns nothing about
    // what this route wants.
    if (!(await User.verifyPassword(req.user.id, password))) {
      return res.status(401).json({
        success: false,
        error: 'Password is incorrect'
      });
    }

    // No default. Which of their published work survives is the one thing a user cannot be assumed into.
    if (typeof deleteContent !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Choose whether your published listings and comments are deleted too'
      });
    }

    // A request already standing is left exactly as it is, rather than re-stamped. Asking twice must not
    // push the date out, or an account could be held in the window indefinitely by repeating the request.
    const standing = User.deletionRequestedAt(req.user.id);
    if (standing) {
      return res.status(200).json({
        success: true,
        deletionScheduledFor: erasureDue(standing)
      });
    }

    const requestedAt = User.requestDeletion(req.user.id, deleteContent);

    AuditLog.tryRecord({
      action: 'account_deletion_requested',
      actor: req.user,
      targetKind: 'account',
      targetName: req.user.username,
      snippet: deleteContent ? 'content deleted' : 'content kept'
    });

    res.status(200).json({
      success: true,
      deletionScheduledFor: erasureDue(requestedAt)
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get current user profile
 * @route   GET /api/auth/me
 * @access  Private
 */
exports.getMe = async (req, res, next) => {
  try {
    const user = User.findById(req.user.id);

    res.status(200).json({
      success: true,
      user: { ...accountSummary(user), createdAt: user.created_at }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Set or replace the email address on the signed-in account
 * @route   POST /api/auth/email
 * @access  Private
 */
exports.setEmail = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    const address = addressGiven(req.body.email);
    const current = User.findById(req.user.id);

    // Saving the address already on file is not a change of address, so a stamp on it stands. Without
    // this, opening the account page and pressing Save would quietly undo a verification the player had
    // already done. An account with no address folds to null, which no real address matches.
    const unchanged = foldedAddress(current.email) === foldedAddress(address);

    let user = current;
    if (!unchanged) {
      // A new address is unproven, whatever the old one was. Both columns move in one statement, so no
      // moment exists where the row carries the new address under the old address's stamp.
      //
      // Taken addresses are refused by the unique index rather than by a lookup first, for the reason
      // register gives. This statement writes one unique column, so a collision can only be the email.
      try {
        user = User.update(req.user.id, { email: address, email_verified_at: null });
      } catch (error) {
        if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;

        return res.status(409).json({
          success: false,
          code: 'EMAIL_TAKEN',
          error: 'That email address is already registered'
        });
      }
    }

    // Nothing to prove about an address already proven, which is only reachable on the unchanged branch.
    const mailSent = user.email_verified_at
      ? false
      : await tryVerificationMail({ userId: user.id, email: user.email });

    res.status(200).json({
      success: true,
      user: accountSummary(user),
      mailSent
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Ask for the verification mail again
 * @route   POST /api/auth/resend-verification
 * @access  Private
 */
exports.resendVerification = async (req, res, next) => {
  try {
    const user = User.findById(req.user.id);

    if (!user.email) {
      return res.status(400).json({
        success: false,
        error: 'Add an email address before asking for the verification mail'
      });
    }

    // Answered as success, because the state the caller wanted is the state they are already in. A
    // refusal would only invite them to try again, and each try costs somebody a mail.
    if (user.email_verified_at) {
      return res.status(200).json({
        success: true,
        emailVerified: true,
        mailSent: false
      });
    }

    const mailSent = await tryVerificationMail({ userId: user.id, email: user.email });

    res.status(200).json({
      success: true,
      emailVerified: false,
      mailSent
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Prove an email address by opening the link mailed to it
 * @route   POST /api/auth/verify-email
 * @access  Public
 */
exports.verifyEmail = async (req, res, next) => {
  try {
    const { token } = req.body;

    // Public and unauthenticated: whoever opens the link may not be signed in on the device that opened
    // it, and requiring a session would make the mail useless from a phone. The token is the credential.
    const userId = AccountToken.consume({ token, purpose: VERIFY });

    if (!userId) {
      return res.status(400).json({
        success: false,
        code: 'TOKEN_INVALID',
        error: 'That verification link has expired or has already been used'
      });
    }

    User.markEmailVerified(userId);
    const user = User.findById(userId);

    res.status(200).json({
      success: true,
      email: user.email,
      emailVerified: true
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Ask for a reset link, by email address or by username
 * @route   POST /api/auth/request-password-reset
 * @access  Public
 */
exports.requestPasswordReset = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    // Either kind of name, because the player has forgotten a password and may well have forgotten which
    // address they used. A name that is somebody's username and somebody else's address cannot happen:
    // the address column holds addresses, and no username is one.
    const typed = addressGiven(req.body.account);

    // Both lookups run whichever one hits, so the two branches cost the same. Skipping the second on a
    // match would make an address that resolves measurably cheaper than a name nobody holds.
    const byAddress = User.findByEmail(typed);
    const byName = User.findByUsername(typed);
    const user = byAddress || byName;

    // Answered before anything is mailed, and with the same body whatever was found. This is what keeps
    // the route from being a way to ask whether somebody has an account here: minting a token and handing
    // a message to Resend takes far longer than finding nothing, so a response that waited for it would
    // time the answer even while wording it identically.
    res.status(200).json({ success: true });

    // Only a proven address. An unverified one is a stranger's until it is proven, and a reset link is
    // the account — so this is the line that keeps a typo at registration from giving it away.
    if (user && user.email_verified_at) await tryResetMail({ userId: user.id, email: user.email });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Set a new password with a mailed reset token
 * @route   POST /api/auth/reset-password
 * @access  Public
 */
exports.resetPassword = async (req, res, next) => {
  try {
    // Judged before the token is spent. A password the form should have caught must not cost somebody
    // their link, or one typo means waiting for another mail.
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    // Public and unauthenticated, for the reason `verifyEmail` gives: the link is opened wherever the
    // mail was read. The token is the credential, and it is the only one — whoever holds it has proven
    // they read mail sent to the verified address, which is the whole basis of the reset.
    const userId = AccountToken.consume({ token: req.body.token, purpose: RESET });

    if (!userId) {
      return res.status(400).json({
        success: false,
        code: 'TOKEN_INVALID',
        error: 'That reset link has expired or has already been used'
      });
    }

    // A token can outlive the account it names by the width of this handler: erasure runs on its own
    // schedule and cascades the token rows away, so a link opened at that moment finds nothing to write.
    // Answered as a dead link, which is what it now is.
    const written = await User.setPassword(userId, req.body.newPassword);

    if (!written) {
      return res.status(400).json({
        success: false,
        code: 'TOKEN_INVALID',
        error: 'That reset link has expired or has already been used'
      });
    }

    // No session comes back. Somebody resetting a password usually suspects another person had it, and
    // the point of the version bump is that every session on the account is now gone — handing one back
    // here would make this route the exception to the rule it exists to enforce. The name goes back
    // instead: somebody who asked by address may not remember the username the sign-in form wants.
    const user = User.findById(userId);

    res.status(200).json({
      success: true,
      username: user.username
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Change password
 * @route   POST /api/auth/change-password
 * @access  Private
 */
exports.changePassword = async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // Validate input
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: 'Please provide current password and new password'
      });
    }

    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      return res.status(400).json({
        success: false,
        error: PASSWORD_RULE
      });
    }

    // Change password
    const success = await User.changePassword(req.user.id, currentPassword, newPassword);

    if (!success) {
      return res.status(400).json({
        success: false,
        error: 'Failed to change password'
      });
    }

    // Changing the password retires every token issued under the old one — including the one that made
    // this very request. A fresh token comes back so the caller stays signed in here while every other
    // session ends, which is the point of changing it.
    const user = User.findById(req.user.id);

    res.status(200).json({
      success: true,
      token: generateToken(user),
      message: 'Password updated successfully'
    });
  } catch (error) {
    // Handle specific error messages
    if (error.message === 'Current password is incorrect') {
      return res.status(400).json({
        success: false,
        error: error.message
      });
    }
    next(error);
  }
};
