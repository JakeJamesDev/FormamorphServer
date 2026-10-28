const express = require('express');
const { getEntitlement } = require('../controllers/supporterContentController');
const { protect } = require('../middleware/auth');

const router = express.Router();

// Whether the signed-in account may install Supporter content, and which listings it may install.
router.get('/entitlement', protect, getEntitlement);

module.exports = router;
