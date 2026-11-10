const express = require('express');
const { mailEvent } = require('../controllers/mailEventController');

const router = express.Router();

// SES events from an EventBridge API destination. Public: the shared secret header is the authentication.
// 256 KB is the largest event EventBridge carries.
router.post('/events', express.raw({ type: () => true, limit: '256kb' }), mailEvent);

module.exports = router;
