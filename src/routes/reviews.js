const express = require('express');
const { getMeta, getAutoApprovals } = require('../controllers/reviewController');
const { protect, staff } = require('../middleware/auth');

const router = express.Router();

// Open to everyone, signed in or not: a client reads it to decide whether to show review at all.
router.get('/meta', getMeta);

// Recent listings that skipped review, for staff to spot-check. Ahead of any `/:id` route.
router.get('/auto', protect, staff, getAutoApprovals);

module.exports = router;
