const { openEventPoster } = require('../utils/fileStorage');
const { createImageAssetRouter } = require('./imageAssetRouter');

/**
 * @desc    Get an event's poster artwork by filename
 * @route   GET /api/event-posters/:filename
 * @access  Public
 */
module.exports = createImageAssetRouter({
  open: openEventPoster,
  // Only what `saveEventPoster` writes.
  contentTypes: {
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp'
  },
  noun: 'Poster'
});
