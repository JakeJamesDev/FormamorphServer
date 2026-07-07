const express = require('express');
const { check } = require('express-validator');
const { getWorlds, getWorld, getWorldContent, createWorld, updateWorld, deleteWorld, setSpoilerStatus } = require('../controllers/worldController');
const { getComments, createComment } = require('../controllers/commentController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// World content can be large (up to 200MB); other bodies here stay tightly capped.
const largeJson = express.json({ limit: '200mb' });
const smallJson = express.json({ limit: '100kb' });

// Get all worlds
router.get('/', getWorlds);

// Get single world
router.get('/:id', getWorld);

// Get world content
router.get('/:id/content', getWorldContent);

// Create new world
router.post(
  '/',
  largeJson,
  [
    check('name', 'Name is required').not().isEmpty(),
    check('name', 'Name cannot exceed 100 characters').isLength({ max: 100 }),
    check('description', 'Description is required').not().isEmpty(),
    check('thumbnail', 'Thumbnail is required').not().isEmpty(),
    check('contentData', 'Content data is required').not().isEmpty()
  ],
  protect,
  createWorld
);

// Update world
router.put(
  '/:id',
  largeJson,
  [
    check('name', 'Name cannot exceed 100 characters').optional().isLength({ max: 100 })
  ],
  protect,
  updateWorld
);

// Set world spoiler status
router.put(
  '/:id/spoiler',
  smallJson,
  [
    check('spoiler', 'Spoiler must be a boolean value').isBoolean()
  ],
  protect,
  setSpoilerStatus
);

// Delete world
router.delete('/:id', protect, deleteWorld);

// Comment routes
// Get all comments for a world
router.get('/:worldId/comments', getComments);

// Create new comment for a world
router.post(
  '/:worldId/comments',
  smallJson,
  [
    check('content', 'Content is required').not().isEmpty(),
    check('content', 'Content cannot exceed 1000 characters').isLength({ max: 1000 })
  ],
  protect,
  createComment
);

module.exports = router;
