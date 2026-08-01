const World = require('../models/World');
const User = require('../models/User');
const { validationResult } = require('express-validator');
const { saveWorldContent, saveThumbnail, deleteWorldContent, deleteThumbnail, getThumbnailBase64 } = require('../utils/fileStorage');
const { DEFAULT_KIND, rulesFor } = require('../config/kinds');
const { kindFromQuery } = require('../utils/kindQuery');
const { placeholderFor } = require('../config/placeholderThumbnails');
const { v4: uuidv4 } = require('uuid');
const AuditLog = require('../models/AuditLog');

/**
 * The kind's content ceiling as an error string, or null when it fits.
 *
 * Shared by create and update so the cap is a property of the row rather than of whichever path wrote it:
 * enforcing it on create alone means a 1KB dictionary can be PUT up to the global 200MB a moment later.
 */
function contentSizeError(contentData, rules) {
  if (!contentData) return null;
  const bytes = Buffer.byteLength(JSON.stringify(contentData));
  if (bytes <= rules.maxContentBytes) return null;
  return `${rules.label} content exceeds the ${Math.round(rules.maxContentBytes / 1024 / 1024)}MB limit`;
}

/**
 * @desc    Get all worlds
 * @route   GET /api/worlds
 * @access  Public
 */
exports.getWorlds = async (req, res, next) => {
  try {
    // Extract query parameters
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 10;
    const search = req.query.search || '';
    const tags = req.query.tags || '';
    const searchByAuthor = req.query.searchByAuthor === 'true';
    const sort = req.query.sort || 'created_at';
    const order = req.query.order || 'desc';
    // Absent `kind` means a client that predates the column — it must keep seeing worlds only.
    const { kind, error } = kindFromQuery(req);
    if (error) {
      return res.status(400).json({ success: false, error });
    }

    // Get worlds
    const result = World.getAll({
      page,
      limit,
      search,
      tags,
      searchByAuthor,
      sort,
      order,
      kind
    });

    res.status(200).json({
      success: true,
      count: result.worlds.length,
      pagination: result.pagination,
      total: result.total,
      data: result.worlds
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get single world
 * @route   GET /api/worlds/:id
 * @access  Public
 */
exports.getWorld = async (req, res, next) => {
  try {
    // Extract query parameters for comments
    const page = parseInt(req.query.commentsPage, 10) || 1;
    const limit = parseInt(req.query.commentsLimit, 10) || 5;
    const includeComments = req.query.includeComments === 'true';
    
    // Get world with or without comments based on query parameter
    const world = includeComments 
      ? World.findByIdWithAuthorAndComments(req.params.id, { page, limit })
      : World.findByIdWithAuthor(req.params.id);

    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Get thumbnail as base64
    world.thumbnail = await getThumbnailBase64(world.thumbnail_file);
    delete world.thumbnail_file;

    res.status(200).json({
      success: true,
      data: world
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Get world content
 * @route   GET /api/worlds/:id/content
 * @access  Public
 */
exports.getWorldContent = async (req, res, next) => {
  try {
    // Increment download count
    World.incrementDownloads(req.params.id);

    // Get world with content
    const world = await World.getContent(req.params.id);

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

/**
 * @desc    Create new world
 * @route   POST /api/worlds
 * @access  Private
 */
exports.createWorld = async (req, res, next) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    // Check if user is suspended
    if (req.user.status === 'suspended') {
      return res.status(403).json({
        success: false,
        error: 'Suspended users cannot upload worlds'
      });
    }

    // Extract data from request body
    const { name, description, thumbnail, previewData, contentData } = req.body;
    
    // Extract tags from contentData.worldOverview (preferred), then worldOverview, then a direct tags field
    let tags;
    if (contentData && contentData.worldOverview && contentData.worldOverview.tags !== undefined) {
      tags = contentData.worldOverview.tags;
    } else if (req.body.worldOverview && req.body.worldOverview.tags !== undefined) {
      tags = req.body.worldOverview.tags;
    } else if (req.body.tags !== undefined) {
      tags = req.body.tags;
    }

    // Validate required fields
    if (!name || !contentData) {
      return res.status(400).json({ success: false, message: 'Name and content data are required' });
    }

    const kind = req.body.kind || DEFAULT_KIND;
    const rules = rulesFor(kind);

    // Size is capped per kind: a world may legitimately carry 200MB of base64 art, a lorebook may not.
    const tooLarge = contentSizeError(contentData, rules);
    if (tooLarge) {
      return res.status(400).json({ success: false, error: tooLarge });
    }

    // Generate UUID for the world
    const worldId = uuidv4();

    try {
      // A kind that can't promise an image falls back to its stand-in art, routed through the same save
      // path so the row owns its own copy and per-row deletion still applies.
      const thumbnailSource = thumbnail || placeholderFor(kind);
      const thumbnailFile = await saveThumbnail(thumbnailSource);

      // Save content to file
      const contentFile = await saveWorldContent(worldId, contentData);

      // Create world in database
      const world = World.create(
        {
          id: worldId,
          name,
          // `description` is NOT NULL; an empty string satisfies it for the kinds that have none to give,
          // which avoids a table rebuild on a live database just to relax the constraint.
          description: description || '',
          author_id: req.user.id,
          preview_data: previewData,
          tags,
          kind
        },
        contentFile,
        thumbnailFile
      );

      // Get full world data for response
      const fullWorld = await World.getContent(worldId);

      res.status(201).json({
        success: true,
        data: fullWorld
      });
    } catch (error) {
      // If the error is related to content size, return a 400 error
      if (error.message && error.message.includes('exceeds maximum size')) {
        return res.status(400).json({
          success: false,
          error: error.message
        });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Update world
 * @route   PUT /api/worlds/:id
 * @access  Private
 */
exports.updateWorld = async (req, res, next) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    // Get world
    let world = World.findById(req.params.id);

    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Check if user is suspended and not an admin
    if (req.user.status === 'suspended' && req.user.account_type !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Suspended users cannot update worlds'
      });
    }

    // Check if user is world owner or admin
    if (world.author_id !== req.user.id && req.user.account_type !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to update this world'
      });
    }

    // Extract data from request body
    const { name, description, thumbnail, previewData, contentData } = req.body;

    // The stored row's kind is authoritative and immutable — a listing cannot turn from a world into a
    // character. Without this, a PUT naming someone's world writes character content into it while the row
    // still reads `kind='world'`: the catalog lists it as a world and the client migrates a character as
    // one. The client only ever offers same-kind targets, but that's a UI convention, not a rule.
    const kind = world.kind || DEFAULT_KIND;
    if (req.body.kind && req.body.kind !== kind) {
      return res.status(400).json({
        success: false,
        error: `Cannot change a ${kind} listing into a ${req.body.kind}`
      });
    }

    // Same ceiling as create: the cap belongs to the row, not to the path that wrote it.
    const tooLarge = contentSizeError(contentData, rulesFor(kind));
    if (tooLarge) {
      return res.status(400).json({ success: false, error: tooLarge });
    }

    // Extract tags from contentData.worldOverview (preferred), then worldOverview, then a direct tags field
    let tags;
    if (req.body.contentData && req.body.contentData.worldOverview && req.body.contentData.worldOverview.tags !== undefined) {
      tags = req.body.contentData.worldOverview.tags;
    } else if (req.body.worldOverview && req.body.worldOverview.tags !== undefined) {
      tags = req.body.worldOverview.tags;
    } else if (req.body.tags !== undefined) {
      tags = req.body.tags;
    }

    // Prepare update data
    const updateData = {};
    if (name) updateData.name = name;
    if (description !== undefined) updateData.description = description;
    if (previewData) updateData.preview_data = previewData;
    if (tags !== undefined) updateData.tags = tags; // Include tags if provided

    try {
      // If thumbnail is provided, update it
      if (thumbnail) {
        // Delete old thumbnail
        if (world.thumbnail_file) {
          await deleteThumbnail(world.thumbnail_file);
        }
        
        // Save new thumbnail
        const thumbnailFile = await saveThumbnail(thumbnail);
        updateData.thumbnail_file = thumbnailFile;
      }

      // If content data is provided, update it
      if (contentData) {
        // Save new content
        await saveWorldContent(world.id, contentData);
      }

      // Update world in database
      if (Object.keys(updateData).length > 0) {
        world = World.update(req.params.id, updateData);
      }

      // Get full world data for response
      const fullWorld = await World.getContent(req.params.id);

      res.status(200).json({
        success: true,
        data: fullWorld
      });
    } catch (error) {
      // If the error is related to content size, return a 400 error
      if (error.message && error.message.includes('exceeds maximum size')) {
        return res.status(400).json({
          success: false,
          error: error.message
        });
      }
      throw error;
    }
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Set world spoiler status
 * @route   PUT /api/worlds/:id/spoiler
 * @access  Private (world owner or admin only)
 */
exports.setSpoilerStatus = async (req, res, next) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array()
      });
    }

    // Get world
    let world = World.findById(req.params.id);

    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Check if user is world owner or admin
    if (world.author_id !== req.user.id && req.user.account_type !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to update this world'
      });
    }

    // Extract spoiler status from request body
    const { spoiler } = req.body;

    // Validate spoiler is a boolean
    if (typeof spoiler !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Spoiler must be a boolean value'
      });
    }

    // Update world spoiler status without updating the updated_at timestamp
    world = World.updateSpoilerStatus(req.params.id, spoiler);

    // Convert spoiler back to boolean for response
    world.spoiler = world.spoiler === 1;

    res.status(200).json({
      success: true,
      data: {
        id: world.id,
        name: world.name,
        spoiler: world.spoiler
      }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Delete world
 * @route   DELETE /api/worlds/:id
 * @access  Private
 */
exports.deleteWorld = async (req, res, next) => {
  try {
    // Get world
    const world = World.findById(req.params.id);

    if (!world) {
      return res.status(404).json({
        success: false,
        error: 'World not found'
      });
    }

    // Check if user is world owner or admin
    if (world.author_id !== req.user.id && req.user.account_type !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Not authorized to delete this world'
      });
    }

    // Delete content file
    if (world.content_file) {
      await deleteWorldContent(world.content_file);
    }

    // Delete thumbnail file
    if (world.thumbnail_file) {
      await deleteThumbnail(world.thumbnail_file);
    }

    // Delete world from database
    World.delete(req.params.id);

    // Logged whoever did it: an author tidying up and an admin taking something down are the same
    // disappearance to anyone asking where it went, and the entry says which it was.
    AuditLog.tryRecord({
      action: 'listing_deleted',
      actor: req.user,
      targetUser: world.author_id === req.user.id ? null : User.findById(world.author_id),
      targetKind: world.kind || 'world',
      targetName: world.name,
      snippet: world.description
    });

    res.status(200).json({
      success: true,
      data: {}
    });
  } catch (error) {
    next(error);
  }
};
