const express = require('express');
const path = require('path');
const fs = require('fs');
const { EVENT_POSTERS_DIR } = require('../config/paths');
const router = express.Router();

/** What each stored extension is served as. Only what `saveEventPoster` writes. */
const CONTENT_TYPES = Object.assign(Object.create(null), {
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
});

/**
 * @desc    Get an event's poster artwork by filename
 * @route   GET /api/event-posters/:filename
 * @access  Public
 */
router.get('/:filename', async (req, res, next) => {
  try {
    const filename = path.basename(req.params.filename); // strip any traversal segments
    const contentType = CONTENT_TYPES[path.extname(filename).toLowerCase()];

    // An extension nothing is ever stored under cannot name a real poster, so it is a miss rather than
    // a file to guess a type for.
    if (!contentType) {
      return res.status(404).json({ success: false, error: 'Poster not found' });
    }

    const posterPath = path.join(EVENT_POSTERS_DIR, filename);
    if (!fs.existsSync(posterPath)) {
      return res.status(404).json({ success: false, error: 'Poster not found' });
    }

    res.setHeader('Content-Type', contentType);

    // The filename is a fresh UUID per upload, so this URL's contents can never change — cache it hard.
    // A replacement arrives under a different URL, and a removal leaves nothing pointing here.
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    // Public assets embedded by the web/desktop client on a different origin, so relax Helmet's default
    // Cross-Origin-Resource-Policy the same way thumbnails do — otherwise the browser blocks the image.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    fs.createReadStream(posterPath).pipe(res);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
