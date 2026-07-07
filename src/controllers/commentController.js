const Comment = require('../models/Comment');
const World = require('../models/World');
const { validationResult } = require('express-validator');

/**
 * @desc    Get all comments for a world
 * @route   GET /api/worlds/:worldId/comments
 * @access  Public
 */
exports.getComments = async (req, res, next) => {
  try {
    // Check if world exists
    const world = World.findById(req.params.worldId);
    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Extract query parameters
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;

    // Get comments
    const result = Comment.getByWorldId(req.params.worldId, {
      page,
      limit
    });

    res.status(200).json({
      success: true,
      count: result.comments.length,
      pagination: result.pagination,
      total: result.total,
      data: result.comments
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get single comment
 * @route   GET /api/comments/:id
 * @access  Public
 */
exports.getComment = async (req, res, next) => {
  try {
    const comment = Comment.findByIdWithAuthor(req.params.id);

    if (!comment) {
      return res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
    }

    res.status(200).json({
      success: true,
      data: comment
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Create new comment
 * @route   POST /api/worlds/:worldId/comments
 * @access  Private
 */
exports.createComment = async (req, res, next) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    // Check if world exists
    const world = World.findById(req.params.worldId);
    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Check if user is suspended
    if (req.user.status === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Suspended users cannot post comments'
      });
    }

    // Extract data from request body
    const { content } = req.body;

    // Create comment
    const comment = Comment.create({
      content,
      world_id: req.params.worldId,
      author_id: req.user.id
    });

    res.status(201).json({
      success: true,
      data: comment
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update comment
 * @route   PUT /api/comments/:id
 * @access  Private
 */
exports.updateComment = async (req, res, next) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    // Get comment
    let comment = Comment.findById(req.params.id);

    if (!comment) {
      return res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
    }

    // Check if user is suspended and not an admin
    if (req.user.status === 'suspended' && req.user.account_type !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Suspended users cannot update comments'
      });
    }

    // Check if user is comment author or admin
    if (comment.author_id !== req.user.id && req.user.account_type !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to update this comment'
      });
    }

    // Extract data from request body
    const { content } = req.body;

    // Update comment
    comment = Comment.update(req.params.id, {
      content
    });

    res.status(200).json({
      success: true,
      data: comment
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete comment
 * @route   DELETE /api/comments/:id
 * @access  Private
 */
exports.deleteComment = async (req, res, next) => {
  try {
    // Get comment
    const comment = Comment.findById(req.params.id);

    if (!comment) {
      return res.status(404).json({
        success: false,
        error: 'Comment not found'
      });
    }

    // Get world to check if user is world owner
    const world = World.findById(comment.world_id);
    
    // Check if user is comment author, world owner, or admin
    if (
      comment.author_id !== req.user.id && 
      world.author_id !== req.user.id && 
      req.user.account_type !== 'admin'
    ) {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to delete this comment'
      });
    }

    // Delete comment
    Comment.delete(req.params.id);

    res.status(200).json({
      success: true,
      data: {}
    });
  } catch (error) {
    next(error);
  }
};
