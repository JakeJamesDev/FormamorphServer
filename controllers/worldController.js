const World = require('../models/World');
const User = require('../models/User');
const { validationResult } = require('express-validator');

// @desc    Get all worlds
// @route   GET /api/worlds
// @access  Public
exports.getWorlds = async (req, res, next) => {
  try {
    // Pagination
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    
    // Check if searching by author
    const searchByAuthor = req.query.searchByAuthor === 'true';
    const searchTerm = req.query.search;
    
    let worlds = [];
    let total = 0;
    
    // If searching by author name
    if (searchByAuthor && searchTerm) {
      // Find users whose username matches the search term
      const users = await User.find({ 
        username: { $regex: searchTerm, $options: 'i' } 
      }).select('_id');
      
      // Get user IDs
      const userIds = users.map(user => user._id);
      
      // Build query to find worlds by these authors
      const query = { author: { $in: userIds } };
      
      // Add tag filtering if provided
      if (req.query.tags) {
        const tags = req.query.tags.split(',');
        query.tags = { $in: tags };
      }
      
      // Get total count
      total = await World.countDocuments(query);
      
      // Execute query with pagination
      worlds = await World.find(query)
        .select('name description thumbnail downloads tags createdAt updatedAt author')
        .populate('author', 'username')
        .sort({ createdAt: -1 })
        .skip(startIndex)
        .limit(limit);
    } 
    // Default search by name, description, or tags
    else {
      // Build query
      const query = {};

      // Search by name, description, or tags
      if (searchTerm) {
        // Use regex for partial matching instead of text search
        query.$or = [
          { name: { $regex: searchTerm, $options: 'i' } },
          { description: { $regex: searchTerm, $options: 'i' } },
          { tags: { $regex: searchTerm, $options: 'i' } }
        ];
      }

      // Filter by tags
      if (req.query.tags) {
        const tags = req.query.tags.split(',');
        query.tags = { $in: tags };
      }
      
      // Get total count
      total = await World.countDocuments(query);
      
      // Execute query with pagination
      worlds = await World.find(query)
        .select('name description thumbnail downloads tags createdAt updatedAt author')
        .populate('author', 'username')
        .sort({ createdAt: -1 })
        .skip(startIndex)
        .limit(limit);
    }

    // Pagination result
    const pagination = {};

    if (endIndex < total) {
      pagination.next = {
        page: page + 1,
        limit
      };
    }

    if (startIndex > 0) {
      pagination.prev = {
        page: page - 1,
        limit
      };
    }

    res.status(200).json({
      success: true,
      count: worlds.length,
      pagination,
      total,
      data: worlds
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single world
// @route   GET /api/worlds/:id
// @access  Public
exports.getWorld = async (req, res, next) => {
  try {
    const world = await World.findById(req.params.id)
      .select('name description thumbnail downloads tags createdAt updatedAt author')
      .populate('author', 'username');

    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    res.status(200).json({
      success: true,
      data: world
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get world content
// @route   GET /api/worlds/:id/content
// @access  Public
exports.getWorldContent = async (req, res, next) => {
  try {
    const world = await World.findById(req.params.id);

    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Increment download count
    world.downloads += 1;
    await world.save();

    res.status(200).json({
      success: true,
      data: world
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new world
// @route   POST /api/worlds
// @access  Private
exports.createWorld = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    // Check if user is suspended
    if (req.user.status === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Suspended users cannot upload worlds'
      });
    }

    // Add user to req.body
    req.body.author = req.user.id;

    // Create world
    const world = await World.create(req.body);

    res.status(201).json({
      success: true,
      data: world
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update world
// @route   PUT /api/worlds/:id
// @access  Private
exports.updateWorld = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    // Get world
    let world = await World.findById(req.params.id);

    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Get current user to check if admin
    const User = require('../models/User');
    const currentUser = await User.findById(req.user.id);

    // Check if user is suspended and not an admin
    if (currentUser.status === 'suspended' && currentUser.accountType !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Suspended users cannot update worlds'
      });
    }

    // Check if user is world owner or admin
    if (world.author.toString() !== req.user.id && currentUser.accountType !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to update this world'
      });
    }

    // Update world
    world = await World.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });

    res.status(200).json({
      success: true,
      data: world
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete world
// @route   DELETE /api/worlds/:id
// @access  Private
exports.deleteWorld = async (req, res, next) => {
  try {
    // Get world
    const world = await World.findById(req.params.id);

    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Get current user to check if admin
    const User = require('../models/User');
    const currentUser = await User.findById(req.user.id);

    // Check if user is world owner or admin
    if (world.author.toString() !== req.user.id && currentUser.accountType !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to delete this world'
      });
    }

    // Delete world
    await World.deleteOne({ _id: world._id });

    res.status(200).json({
      success: true,
      data: {}
    });
  } catch (error) {
    next(error);
  }
};
