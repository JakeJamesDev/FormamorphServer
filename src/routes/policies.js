const express = require('express');
const {
  getPolicies,
  getPoliciesForAdmin,
  savePolicy,
  acceptUploadGate,
  declineUploadGate,
  resetUploadGate,
  matchTags
} = require('../controllers/policyController');
const { protect, admin } = require('../middleware/auth');

const router = express.Router();

// Literal paths first, so none of them is read as a policy ID.

// Both policies for editing, including disabled drafts (admin only)
router.get('/manage', protect, admin, getPoliciesForAdmin);

// Accept the upload gate
router.post('/upload-gate/accept', protect, acceptUploadGate);

// Record a decline; enforces nothing, but tells an admin they were asked and said no
router.post('/upload-gate/decline', protect, declineUploadGate);

// Require the gate to be accepted again — one user with `{ userId }`, everyone without (admin only)
router.post('/upload-gate/reset', protect, admin, resetUploadGate);

// Which of a publish's tags the tag notice covers
router.post('/tag-notice/match', protect, matchTags);

// The popups that apply to the current user
router.get('/', protect, getPolicies);

// Write a policy (admin only)
router.put('/:id', protect, admin, savePolicy);

module.exports = router;
