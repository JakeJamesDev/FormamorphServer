const express = require('express');
const { check } = require('express-validator');
const {
  getWorlds,
  getWorld,
  getWorldContent,
  createWorld,
  updateWorld,
  deleteWorld
} = require('../controllers/worldController');
const { protect, checkOwnership } = require('../middleware/auth');
const World = require('../models/World');

const router = express.Router();

// Get all worlds
router.get('/', getWorlds);

// Get single world
router.get('/:id', getWorld);

// Get world content
router.get('/:id/content', getWorldContent);

// Create world
router.post(
  '/',
  [
    check('name', 'Name is required').not().isEmpty(),
    check('description', 'Description is required').not().isEmpty(),
    check('thumbnail', 'Thumbnail is required').not().isEmpty(),
    check('previewData', 'Preview data is required').not().isEmpty(),
    check('contentData', 'Content data is required').not().isEmpty()
  ],
  protect,
  createWorld
);

// Update world
router.put(
  '/:id',
  [
    check('name', 'Name is required').optional().not().isEmpty(),
    check('description', 'Description is required').optional().not().isEmpty(),
    check('thumbnail', 'Thumbnail is required').optional().not().isEmpty(),
    check('previewData', 'Preview data is required').optional().not().isEmpty(),
    check('contentData', 'Content data is required').optional().not().isEmpty()
  ],
  protect,
  updateWorld
);

// Delete world
router.delete('/:id', protect, deleteWorld);

module.exports = router;
