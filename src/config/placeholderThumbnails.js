const fs = require('fs');
const path = require('path');

/**
 * Stand-in cover art for kinds that can't promise an image: a dictionary has none at all, and a
 * character's portrait is optional.
 *
 * Read once into data-URIs so they can go through the ordinary `saveThumbnail` path — that gives each row
 * its own uuid-named copy, so the existing per-row deletion applies unchanged. Pointing many rows at one
 * shared file would instead mean deleting any one of them removes everyone else's thumbnail.
 *
 * Swap the PNGs in `assets/placeholders` to change the art; nothing here needs to know.
 */
const PLACEHOLDER_DIR = path.join(__dirname, '..', 'assets', 'placeholders');

const load = (name) =>
  `data:image/png;base64,${fs.readFileSync(path.join(PLACEHOLDER_DIR, `${name}.png`)).toString('base64')}`;

const PLACEHOLDER_THUMBNAILS = {
  entity: load('entity'),
  dictionary: load('dictionary'),
  // Avatars have no art of their own yet; reuse the entity placeholder rather than commission new art.
  model: load('entity'),
};

/** The stand-in for a kind, or null when the kind is expected to supply its own (worlds). */
const placeholderFor = (kind) => PLACEHOLDER_THUMBNAILS[kind] || null;

module.exports = { PLACEHOLDER_THUMBNAILS, placeholderFor };
