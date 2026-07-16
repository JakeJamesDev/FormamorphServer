const express = require('express');
const path = require('path');
const fs = require('fs');
const { THUMBNAILS_DIR } = require('../config/paths');
const router = express.Router();

/**
 * @desc    Get thumbnail image by filename
 * @route   GET /api/thumbnails/:filename
 * @access  Public
 */
router.get('/:filename', async (req, res, next) => {
  try {
    const filename = path.basename(req.params.filename); // strip any traversal segments
    const thumbnailPath = path.join(THUMBNAILS_DIR, filename);
    
    // Check if file exists
    if (!fs.existsSync(thumbnailPath)) {
      return res.status(404).json({
        success: false,
        error: 'Thumbnail not found'
      });
    }
    
    // Determine content type based on file extension
    const ext = path.extname(filename).toLowerCase();
    let contentType = 'image/jpeg'; // Default
    
    if (ext === '.png') contentType = 'image/png';
    else if (ext === '.gif') contentType = 'image/gif';
    else if (ext === '.webp') contentType = 'image/webp';
    
    // Set content type header
    res.setHeader('Content-Type', contentType);

    // Thumbnails are public assets meant to be embedded by the web/desktop client on a different origin,
    // so relax Helmet's default Cross-Origin-Resource-Policy (same-origin) for this route — otherwise the
    // browser blocks the <img> from loading cross-origin.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    // Stream the file
    const fileStream = fs.createReadStream(thumbnailPath);
    fileStream.pipe(res);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
