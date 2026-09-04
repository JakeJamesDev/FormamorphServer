const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { avatarUrlFor } = require('../utils/avatarUrl');
const generateToken = require('../utils/generateToken');
const { recordSignal } = require('../utils/recordSignal');
const { erasureDue, SYSTEM_STATUS } = require('../config/accountDeletion');
const { validationResult } = require('express-validator');

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

    // Check if user already exists
    const existingUser = User.findByUsername(username);
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'Username already exists'
      });
    }

    // Create user
    const user = await User.create({
      username,
      password,
      email
    });

    // The account exists now, so this is the first place a Signal can name it. Four accounts made from one
    // address in two minutes is the pattern this whole table is here to make visible.
    recordSignal(req, user.id, 'signup');

    // Generate token
    const token = generateToken(user);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        status: user.status,
        accountType: user.account_type,
        avatarUrl: avatarUrlFor(user.avatar_file)
      }
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
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        status: user.status,
        accountType: user.account_type,
        avatarUrl: avatarUrlFor(user.avatar_file)
      }
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
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        status: user.status,
        accountType: user.account_type,
        avatarUrl: avatarUrlFor(user.avatar_file),
        createdAt: user.created_at
      }
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

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'New password must be at least 6 characters long'
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
