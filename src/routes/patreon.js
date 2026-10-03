const express = require('express');
const { patreonCallback } = require('../controllers/patreonController');

const router = express.Router();

// Where Patreon sends the browser after approval. Public: the signed state names the account.
router.get('/callback', patreonCallback);

module.exports = router;
