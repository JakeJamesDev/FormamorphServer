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
    // Trimmed before it is checked and before it is stored: without this a body of spaces passes
    // `isEmpty` and blanks the comment.
    check('content', 'Content is required').trim().not().isEmpty(),
    check('content', 'Content cannot exceed 4000 characters').isLength({ max: 4000 })
  ],
  protect,
  updateComment
);

// Delete comment
router.delete('/:id', protect, deleteComment);

module.exports = router;
