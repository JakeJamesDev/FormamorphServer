const User = require('../models/User');
const World = require('../models/World');
const { validationResult } = require('express-validator');
const mongoose = require('mongoose');

// @desc    Get user profile
// @route   GET /api/users/me
// @access  Private
exports.getProfile = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);

    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        status: user.status,
        accountType: user.accountType,
        createdAt: user.createdAt
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get worlds created by a user
// @route   GET /api/users/:id/worlds
// @access  Public
exports.getUserWorlds = async (req, res, next) => {
  try {
    const userId = req.params.id;

    // Check if user exists
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Get worlds created by the user
    const worlds = await World.find({ author: userId })
      .select('name description thumbnail previewData downloads tags createdAt updatedAt')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: worlds.length,
      data: worlds
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get worlds created by current user
// @route   GET /api/users/me/worlds
// @access  Private
exports.getMyWorlds = async (req, res, next) => {
  try {
    // Get worlds created by the current user
    const worlds = await World.find({ author: req.user.id })
      .select('name description thumbnail previewData downloads tags createdAt updatedAt')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: worlds.length,
      data: worlds
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update user status and account type
// @route   PUT /api/users/:id/status
// @access  Private/Admin
exports.updateUserStatus = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    // Check if current user is admin
    const currentUser = await User.findById(req.user.id);
    if (currentUser.accountType !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to perform this action'
      });
    }

    const { status, accountType } = req.body;
    const userId = req.params.id;

    // Validate ObjectId
    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid user ID'
      });
    }

    // Find user to update
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Update user status and account type
    if (status) {
      user.status = status;
    }
    
    if (accountType) {
      user.accountType = accountType;
    }

    user.updatedAt = Date.now();
    await user.save();

    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        status: user.status,
        accountType: user.accountType,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all users (admin only)
// @route   GET /api/users
// @access  Private/Admin
exports.getUsers = async (req, res, next) => {
  try {
    // Check if current user is admin
    const currentUser = await User.findById(req.user.id);
    if (currentUser.accountType !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to perform this action'
      });
    }

    // Get all users
    const users = await User.find()
      .select('username email status accountType createdAt updatedAt')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: users.length,
      data: users
    });
  } catch (error) {
    next(error);
  }
};
