const express = require('express');
const { protect } = require('../middleware/auth');
const { admit, routeError, proxy } = require('../controllers/hostedAiController');
const { HOSTED_BODY_LIMIT } = require('../config/hostedAi');

const router = express.Router();

// Admission runs before the body is parsed, so a refused account never costs a large parse.
router.post(
  '/chat/completions',
  protect,
  admit,
  express.json({ limit: HOSTED_BODY_LIMIT }),
  proxy,
  routeError
);

module.exports = router;
