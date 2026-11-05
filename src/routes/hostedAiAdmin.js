const express = require('express');
const { protect, staff, admin } = require('../middleware/auth');
const {
  createGrant, listGrants, revokeGrant, getSpend, getSpendReport, getUsageReport
} = require('../controllers/hostedAiAdminController');

const router = express.Router();

router.use(protect);

// Grants are staff work. Cost is admin-only, so a moderator gets 403 on the spend routes.
router.post('/grants', staff, express.json({ limit: '10kb' }), createGrant);
router.get('/grants', staff, listGrants);
router.delete('/grants/:id', staff, revokeGrant);

router.get('/spend/:subject', admin, getSpend);
router.get('/spend-report', admin, getSpendReport);
router.get('/usage-report', admin, getUsageReport);

module.exports = router;
