const express = require('express');
const { mailEvent } = require('../controllers/mailEventController');
const { getMailReport } = require('../controllers/mailReportController');
const { protect, admin } = require('../middleware/auth');

const router = express.Router();

// SES events from an EventBridge API destination. Public: the shared secret header is the authentication.
// 256 KB is the largest event EventBridge carries.
router.post('/events', express.raw({ type: () => true, limit: '256kb' }), mailEvent);

router.get('/report', protect, admin, getMailReport);

module.exports = router;
