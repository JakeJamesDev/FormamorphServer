const User = require('../models/User');
const World = require('../models/World');
const Policy = require('../models/Policy');
const Message = require('../models/Message');
const { kindFromQuery } = require('../utils/kindQuery');

/**
 * @desc    Get all users
 * @route   GET /api/users
 * @access  Private/Admin
 */
exports.getUsers = async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    // Clamped so a hand-rolled `limit=100000` can't turn the admin list into a full table dump.
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
    const search = req.query.search || '';
    // An unknown sort field is ignored rather than rejected — it falls back to newest-first, which is
    // what an unsorted table has always shown.
    const sort = Object.prototype.hasOwnProperty.call(User.SORT_FIELDS, req.query.sort) ? req.query.sort : null;
    const order = req.query.order === 'desc' ? 'desc' : 'asc';

    const result = User.getAll({ page, limit, search, sort, order });

    // One query each for the page rather than a per-row lookup.
    const ids = result.users.map(user => user.id);
    const responses = Policy.responsesBy(Policy.UPLOAD_GATE, ids);
    const messageCounts = Message.countsByRecipient(ids);

    res.status(200).json({
      success: true,
      count: result.count,
      pagination: result.pagination,
      // `total` is what matched, `count` is what's in this response — they differ whenever paging bites.
      total: result.total,
      // camelCase to match every other user-shaped response (getMe, updateUserStatus).
      data: result.users.map(user => ({
        id: user.id,
        username: user.username,
        email: user.email,
        status: user.status,
        accountType: user.account_type,
        createdAt: user.created_at,
        updatedAt: user.updated_at,
        // How they last answered the upload gate: 'accepted', 'declined', or 'unanswered' — which
        // covers never being asked and an answer a version bump has since invalidated.
        termsResponse: responses.get(user.id) || 'unanswered',
        // Direct messages sent to them, so the history button can say how much is behind it.
        messageCount: messageCounts.get(user.id) || 0
      }))
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get current user profile
 * @route   GET /api/users/me
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
        createdAt: user.created_at
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get worlds created by current user
 * @route   GET /api/users/me/worlds
 * @access  Private
 */
exports.getMyWorlds = async (req, res, next) => {
  try {
    // Same default as every other list endpoint: no `kind` means worlds only, so a client that predates
    // the column never sees a character among its own published worlds.
    const { kind, error } = kindFromQuery(req);
    if (error) {
      return res.status(400).json({ success: false, error });
    }

    const result = World.getByAuthor(req.user.id, kind);

    res.status(200).json({
      success: true,
      count: result.worlds.length,
      // `total` is what matched, `count` is what's in this response — they differ only if the row ceiling
      // cut something off, which a caller offering each row as a target needs to be able to notice.
      total: result.total,
      data: result.worlds
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get worlds created by a specific user
 * @route   GET /api/users/:id/worlds
 * @access  Public
 */
exports.getUserWorlds = async (req, res, next) => {
  try {
    // Check if user exists
    const user = User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    const { kind, error } = kindFromQuery(req);
    if (error) {
      return res.status(400).json({ success: false, error });
    }

    const result = World.getByAuthor(req.params.id, kind);

    res.status(200).json({
      success: true,
      count: result.worlds.length,
      // `total` is what matched, `count` is what's in this response — they differ only if the row ceiling
      // cut something off, which a caller offering each row as a target needs to be able to notice.
      total: result.total,
      data: result.worlds
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update user status and account type
 * @route   PUT /api/users/:id/status
 * @access  Private/Admin
 */
exports.updateUserStatus = async (req, res, next) => {
  try {
    const { status, accountType } = req.body;

    // Check if user exists
    const user = User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Validate status
    if (status && !['normal', 'flagged', 'suspended'].includes(status)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid status value'
      });
    }

    // Validate account type
    if (accountType && !['normal', 'admin'].includes(accountType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid account type value'
      });
    }

    // Update user
    const updateData = {};
    if (status) updateData.status = status;
    if (accountType) updateData.account_type = accountType;

    // Only update if there are changes
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No update data provided'
      });
    }

    const updatedUser = User.update(req.params.id, updateData);

    res.status(200).json({
      success: true,
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        status: updatedUser.status,
        accountType: updatedUser.account_type,
        createdAt: updatedUser.created_at,
        updatedAt: updatedUser.updated_at
      }
    });
  } catch (error) {
    next(error);
  }
};
