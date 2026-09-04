const express = require('express');
const {
  getPolicies,
  getPrivacyPolicy,
  getPoliciesForAdmin,
  savePolicy,
  acceptUploadGate,
  declineUploadGate,
  resetUploadGate,
  acceptPrivacyPolicy,
  declinePrivacyPolicy,
  resetPrivacyPolicy,
  matchTags
} = require('../controllers/policyController');
// Every route here authenticates with `protectBeforePolicy` rather than `protect`, so the Privacy Policy
// gate does not apply to the routes that exist to answer it. Reading it, accepting it and declining it are
// how a refused account stops being refused; the admin screens are how the owner — who has not accepted it
// either — switches it off again.
const { protectBeforePolicy, admin, staff } = require('../middleware/auth');

const router = express.Router();

// Literal paths first, so none of them is read as a policy ID.

// The Privacy Policy on its own, for a visitor with no account yet. Registration shows it before the
// account exists, so this one read cannot require a token. Nothing else here is public.
router.get('/privacy-policy', getPrivacyPolicy);

// Every policy for editing, including disabled drafts (admin only)
router.get('/manage', protectBeforePolicy, admin, getPoliciesForAdmin);

// Accept the upload gate
router.post('/upload-gate/accept', protectBeforePolicy, acceptUploadGate);

// Record a decline; enforces nothing, but tells an admin they were asked and said no
router.post('/upload-gate/decline', protectBeforePolicy, declineUploadGate);

// Require the gate to be accepted again — one user with `{ userId }` (staff), everyone without (admin).
// One route, two audiences: the controller separates them, since only the body says which this is.
router.post('/upload-gate/reset', protectBeforePolicy, staff, resetUploadGate);

// The same three for the Privacy Policy, which refuses every authenticated route until it is accepted
router.post('/privacy-policy/accept', protectBeforePolicy, acceptPrivacyPolicy);
router.post('/privacy-policy/decline', protectBeforePolicy, declinePrivacyPolicy);
router.post('/privacy-policy/reset', protectBeforePolicy, staff, resetPrivacyPolicy);

// Which of a publish's tags the tag notice covers
router.post('/tag-notice/match', protectBeforePolicy, matchTags);

// The popups that apply to the current user
router.get('/', protectBeforePolicy, getPolicies);

// Write a policy (admin only)
router.put('/:id', protectBeforePolicy, admin, savePolicy);

module.exports = router;
