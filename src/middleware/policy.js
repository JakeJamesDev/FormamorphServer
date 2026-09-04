const Policy = require('../models/Policy');

/**
 * How the server refuses a user who has not accepted a policy, or null when it has nothing to refuse.
 *
 * Answers null while the policy is absent, switched off, or unwritten, so an untouched server behaves
 * exactly as it did before either of these was authored.
 *
 * `code` is what a current client keys off to open the right dialog; `error` is what an older client shows
 * verbatim, so each one has to read as an instruction rather than a bare refusal.
 *
 * @param {string} policyId - Which policy is being enforced
 * @param {string} userId - Who is asking
 * @param {Object} refusal - `{ code, error }`, the two the client acts on
 * @returns {Object|null} The 403 body, or null to let the request through
 */
const refusalFor = (policyId, userId, { code, error }) => {
  if (!Policy.isActive(policyId)) return null;
  if (Policy.hasAccepted(policyId, userId)) return null;

  return { success: false, code, error };
};

/**
 * Refuse a publish until the user has accepted the upload gate.
 *
 * Mounted on world create and update only. Deleting a listing and toggling its spoiler flag are
 * deliberately left ungated: someone who declined the terms, or who an admin has reset, must still be
 * able to take down or flag work they already published.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
exports.requireUploadTerms = (req, res, next) => {
  const refusal = refusalFor(Policy.UPLOAD_GATE, req.user.id, {
    code: 'TERMS_REQUIRED',
    error: 'Publishing requires accepting the contributor terms. Update Formamorph to review and accept them.'
  });

  return refusal ? res.status(403).json(refusal) : next();
};

/**
 * How the server refuses an account that has not accepted the current Privacy Policy.
 *
 * Not middleware, because `protect` applies it itself rather than each route mounting it — that is what
 * makes it cover every authenticated route there is and every one added later. The exemptions are the
 * routes a refused account needs to stop being refused — registering, signing in, changing a password, and
 * the policy routes — and they opt out by authenticating with `protectBeforePolicy`.
 *
 * Refuses nothing while the row is disabled, which is how it is seeded: this deploys ahead of the client
 * that knows how to answer it, and enabling it is the cutover.
 *
 * @param {Object} user - The authenticated user row
 * @returns {Object|null} The 403 body, or null to let the request through
 */
exports.privacyRefusal = (user) => refusalFor(Policy.PRIVACY_POLICY, user.id, {
  code: 'PRIVACY_REQUIRED',
  error: 'Formamorph needs updating to continue.'
});
