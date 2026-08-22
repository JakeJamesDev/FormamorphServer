const { THUMBNAILS_DIR } = require('../config/paths');
const { createImageAssetRouter } = require('./imageAssetRouter');

/**
 * @desc    Get a listing's thumbnail by filename
 * @route   GET /api/thumbnails/:filename
 * @access  Public
 */
module.exports = createImageAssetRouter({
  directory: THUMBNAILS_DIR,
  // Only what `saveThumbnail` writes. A `.jpg` upload is stored as `.jpeg`, so nothing is ever named that.
  contentTypes: {
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  },
  noun: 'Thumbnail'
});
