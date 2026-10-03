const express = require('express');
const { patreonCallback } = require('../controllers/patreonController');
const { patreonWebhook } = require('../controllers/patreonWebhookController');

const router = express.Router();

// Where Patreon sends the browser after approval. Public: the signed state names the account.
router.get('/callback', patreonCallback);

// Patreon's membership changes. Public: the signature covers the raw bytes, so the body stays unparsed.
router.post('/webhook', express.raw({ type: () => true, limit: '1mb' }), patreonWebhook);

module.exports = router;
