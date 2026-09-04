const express = require('express');
const { getSetting, saveSetting } = require('../controllers/settingsController');
const { protect, staff } = require('../middleware/auth');

const router = express.Router();

// Staff only, both ways: a setting here changes how the server answers everyone, and the values name
// internal routes. There is deliberately no public read — a client is told about a minimum by being
// refused by it, not by asking in advance.

// One setting's current value
router.get('/:key', protect, staff, getSetting);

// Replace one setting's value; the map is written whole, not merged
router.put('/:key', protect, staff, saveSetting);

module.exports = router;
