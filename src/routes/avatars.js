const { openAvatar } = require('../utils/fileStorage');
const { createImageAssetRouter } = require('./imageAssetRouter');

/**
 * @desc    Get a profile image by filename
 * @route   GET /api/avatars/:filename
 * @access  Public
 */
module.exports = createImageAssetRouter({
  open: openAvatar,
  // Only what `saveAvatar` writes.
  contentTypes: {
    '.webp': 'image/webp',
    '.png': 'image/png'
  },
  noun: 'Avatar'
});
