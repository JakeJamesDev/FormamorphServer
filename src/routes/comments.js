const express = require('express');
const { check } = require('express-validator');
const { getComment, updateComment, deleteComment } = require('../controllers/commentController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// Get single comment
router.get('/:id', getComment);

// Update comment
router.put(
  '/:id',
  [
    check('content', 'Content is required').not().isEmpty(),
    check('content', 'Content cannot exceed 1000 characters').isLength({ max: 1000 })
  ],
  protect,
  updateComment
);

// Delete comment
router.delete('/:id', protect, deleteComment);

module.exports = router;
