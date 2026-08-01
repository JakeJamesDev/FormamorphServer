const express = require('express');
const { getEntries, getMeta } = require('../controllers/auditController');
const { protect, admin } = require('../middleware/auth');

const router = express.Router();

// Read-only, admin-only, and there is deliberately no route that writes or removes an entry: the log is
// written from inside the actions it records, and an audit trail somebody can edit is not one.

// The actions this server records, so the filter is filled from the server's own list
router.get('/meta', protect, admin, getMeta);

// A page of entries, newest first
router.get('/', protect, admin, getEntries);

module.exports = router;
