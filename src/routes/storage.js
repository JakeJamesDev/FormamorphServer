const express = require('express');
const { getStorageReport } = require('../controllers/storageReportController');
const { protect, admin } = require('../middleware/auth');

const router = express.Router();

router.get('/report', protect, admin, getStorageReport);

module.exports = router;
