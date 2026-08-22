const express = require('express');
const path = require('path');
const fs = require('fs');

/**
 * A router serving one directory of uploaded images.
 *
 * Avatars and event posters differ only in where they live, what they are stored as, and what a miss is
 * called; everything else — the traversal strip, the extension allowlist standing in for a type sniff,
 * the immutable cache header, the relaxed resource policy — is the same answer for every kind. One
 * factory rather than a copy each, so a fix to any of that lands on all of them at once.
 *
 * @param {Object} options
 * @param {string} options.directory - Where the files are stored
 * @param {Object} options.contentTypes - Lowercase extension (with the dot) to the type it is served as
 * @param {string} options.noun - What the 404 calls a miss, capitalized ("Avatar", "Poster")
 * @returns {import('express').Router} A router with the filename route mounted at its root
 */
const createImageAssetRouter = ({ directory, contentTypes, noun }) => {
  const router = express.Router();
  const types = Object.assign(Object.create(null), contentTypes);
  const notFound = { success: false, error: `${noun} not found` };

  router.get('/:filename', async (req, res, next) => {
    try {
      const filename = path.basename(req.params.filename); // strip any traversal segments
      const contentType = types[path.extname(filename).toLowerCase()];

      // An extension nothing is ever stored under cannot name a real file, so it is a miss rather than
      // a file to guess a type for.
      if (!contentType) {
        return res.status(404).json(notFound);
      }

      const filePath = path.join(directory, filename);
      if (!fs.existsSync(filePath)) {
        return res.status(404).json(notFound);
      }

      res.setHeader('Content-Type', contentType);

      // The filename is a fresh UUID per upload, so this URL's contents can never change — cache it hard.
      // A replacement arrives under a different URL, and a removal leaves nothing pointing here.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

      // Public assets embedded by the web/desktop client on a different origin, so relax Helmet's default
      // Cross-Origin-Resource-Policy — otherwise the browser blocks the image from loading.
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

      fs.createReadStream(filePath).pipe(res);
    } catch (error) {
      next(error);
    }
  });

  return router;
};

module.exports = { createImageAssetRouter };
