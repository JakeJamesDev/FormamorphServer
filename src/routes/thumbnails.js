const { THUMBNAILS_DIR } = require('../config/paths');
const { THUMBNAIL_CONTENT_TYPES } = require('../utils/fileStorage');
const { createImageAssetRouter } = require('./imageAssetRouter');

/**
 * @desc    Get a listing's thumbnail by filename
 * @route   GET /api/thumbnails/:filename
 * @access  Public
 */
module.exports = createImageAssetRouter({
  directory: THUMBNAILS_DIR,
  // Shared with `getThumbnailBase64`, which answers for these same files.
  contentTypes: THUMBNAIL_CONTENT_TYPES,
  noun: 'Thumbnail'
});
