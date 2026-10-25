const express = require('express');
const {
  getMeta, getQueue, getQueueCount, getContent, approve, reject, getAutoApprovals
} = require('../controllers/reviewController');
const { protect, staff } = require('../middleware/auth');

const router = express.Router();

// Open to everyone, signed in or not: a client reads it to decide whether to show review at all.
router.get('/meta', getMeta);

// Recent listings that skipped review, for staff to spot-check. Ahead of any `/:id` route.
router.get('/auto', protect, staff, getAutoApprovals);

router.get('/', protect, staff, getQueue);
router.get('/count', protect, staff, getQueueCount);
// The author reads their own waiting content too, so the staff gate is in the controller.
router.get('/:id/content', protect, getContent);
router.post('/:id/approve', protect, staff, approve);
router.post('/:id/reject', protect, staff, reject);

module.exports = router;
