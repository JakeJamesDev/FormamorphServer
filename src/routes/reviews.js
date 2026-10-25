const express = require('express');
const { getMeta } = require('../controllers/reviewController');

const router = express.Router();

// Open to everyone, signed in or not: a client reads it to decide whether to show review at all.
router.get('/meta', getMeta);

module.exports = router;
