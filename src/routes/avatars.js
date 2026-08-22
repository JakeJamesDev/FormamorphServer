const { AVATARS_DIR } = require('../config/paths');
const { createImageAssetRouter } = require('./imageAssetRouter');

/**
 * @desc    Get a profile image by filename
 * @route   GET /api/avatars/:filename
 * @access  Public
 */
module.exports = createImageAssetRouter({
  directory: AVATARS_DIR,
  // Only what `saveAvatar` writes.
  contentTypes: {
    '.webp': 'image/webp',
    '.png': 'image/png'
  },
  noun: 'Avatar'
});
