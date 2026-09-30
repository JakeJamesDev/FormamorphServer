const { INSTALL_HEADER_NAME } = require('../config/anonymousLikes');

/**
 * Mark a response as one reader's to hold: private, always revalidated, and keyed by the credential. A
 * response that carries a guest's hearts is keyed by their Install as well.
 *
 * @param {Object} res - The Express response
 * @param {Object} [options] - `byInstall: true` when guest likes ride on the response
 */
const perReader = (res, { byInstall = false } = {}) => {
  res.setHeader('Cache-Control', 'private, no-cache');
  res.vary('Authorization');
  if (byInstall) res.vary(INSTALL_HEADER_NAME);
};

module.exports = { perReader };
