const Policy = require('../models/Policy');

/**
 * Refuse a publish until the user has accepted the upload gate.
 *
 * Mounted on world create and update only. Deleting a listing and toggling its spoiler flag are
 * deliberately left ungated: someone who declined the terms, or who an admin has reset, must still be
 * able to take down or flag work they already published.
 *
 * Does nothing when no admin has authored and enabled a gate, so an untouched server behaves exactly as
 * it did before.
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
exports.requireUploadTerms = (req, res, next) => {
  if (!Policy.isActive(Policy.UPLOAD_GATE)) return next();
  if (Policy.hasAccepted(Policy.UPLOAD_GATE, req.user.id)) return next();

  // `code` is what a current client keys off to open the gate dialog; `error` is what an older client
  // shows verbatim, so it has to read as an instruction rather than a bare refusal.
  return res.status(403).json({
    success: false,
    code: 'TERMS_REQUIRED',
    error: 'Publishing requires accepting the contributor terms. Update Formamorph to review and accept them.'
  });
};
