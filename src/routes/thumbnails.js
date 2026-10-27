const { THUMBNAIL_CONTENT_TYPES, openThumbnail } = require('../utils/fileStorage');
const { createImageAssetRouter } = require('./imageAssetRouter');

/**
 * @desc    Get a listing's thumbnail by filename
 * @route   GET /api/thumbnails/:filename
 * @access  Public
 */
module.exports = createImageAssetRouter({
  open: openThumbnail,
  // Shared with `getThumbnailBase64`, which answers for these same files.
  contentTypes: THUMBNAIL_CONTENT_TYPES,
  noun: 'Thumbnail'
});
