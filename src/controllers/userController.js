const User = require('../models/User');
const World = require('../models/World');

/**
 * @desc    Get all users
 * @route   GET /api/users
 * @access  Private/Admin
 */
exports.getUsers = async (req, res, next) => {
  try {
    const users = User.getAll();

    res.status(200).json({
      success: true,
      count: users.length,
      data: users
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
    const result = World.getByAuthor(req.user.id);

    res.status(200).json({
      success: true,
      count: result.worlds.length,
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

    const result = World.getByAuthor(req.params.id);

    res.status(200).json({
      success: true,
      count: result.worlds.length,
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
