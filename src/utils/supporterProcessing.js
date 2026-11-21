const crypto = require('crypto');
const fs = require('fs');
const sharp = require('sharp');
const WatermarkMark = require('../models/WatermarkMark');
const pool = require('./markLayerPool');
const {
  saveSupporterFile, readSupporterFile, deleteSupporterFilesWithPrefix
} = require('./fileStorage');

/**
 * The per-account step the gated content route runs on a listing's content before it leaves the server.
 *
 * A Mascot: every base64 image data URL in the content is watermarked with the account's mark, scrambled
 * with the account's seed, and sent as `{ dataUrl, seed, version, sourceWidth, sourceHeight }` in the same
 * place. Any other kind: only the cover and the largest few images carry the mark, as plain lossless WebP
 * data URLs, unscrambled; every other image passes through byte for byte. Anything else passes through.
 */

const MASCOT_KIND = 'mascot';
// A world marks its cover plus this many of its largest images.
const WORLD_MARKED_EXTRAS = 4;
// The watermark survives screenshots and re-encodes from about this size (pixels, width x height).
const WORLD_MIN_PIXELS = 310000;
// Part of the processing version, so a change to the world path retires every older copy.
const WORLD_VERSION_SALT = 'world-mark-only-v1';

const DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/is;
// Separates the seed key from the other uses of JWT_SECRET.
const SEED_PURPOSE = 'supporter-scramble-v1';

const seedFor = (userId, listingId, revision) => crypto
  .createHmac('sha256', process.env.JWT_SECRET)
  .update(`${SEED_PURPOSE}|${userId}|${listingId}|${revision}`)
  .digest()
  .readUInt32BE(0);

// The scrambled copy of one layer, or null when the bytes are not a decodable image.
const processLayer = async (base64, mark, seed) => {
  let decoded;
  try {
    decoded = await sharp(Buffer.from(base64, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch {
    return null;
  }

  const { width, height, channels } = decoded.info;
  const { data, width: paddedWidth, height: paddedHeight, ...format } = await pool.markLayer({ width, height, data: new Uint8ClampedArray(decoded.data) }, mark, seed);
  // Lossless: the client must restore the marked layer exactly.
  const png = await sharp(Buffer.from(data.buffer, data.byteOffset, data.length), {
    raw: { width: paddedWidth, height: paddedHeight, channels }
  }).png().toBuffer();

  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, seed, ...format };
};

const processValue = async (value, mark, seed) => {
  if (typeof value === 'string') {
    const match = DATA_URL.exec(value);
    return (match && await processLayer(match[1], mark, seed)) || value;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await processValue(item, mark, seed));
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = await processValue(item, mark, seed);
    return out;
  }
  return value;
};

// --- worlds ---

/** The string's pixel count and whether it can carry a mark, from its header alone; null when it will not read. */
const imageInfo = async (value) => {
  const match = DATA_URL.exec(value);
  if (!match) return null;
  try {
    const { width, height, pages } = await sharp(Buffer.from(match[1], 'base64')).metadata();
    if (!width || !height) return null;
    return { pixels: width * height, animated: pages > 1 };
  } catch {
    return null;
  }
};

// Every distinct image data URL in the content, in first-appearance order.
const imageStrings = (value, found = new Set()) => {
  if (typeof value === 'string') {
    if (DATA_URL.test(value)) found.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => imageStrings(item, found));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((item) => imageStrings(item, found));
  }
  return found;
};

// The cover: `worldOverview.thumbnail`, a data URL or a `{ mediaId }` into the Media List. Null when neither.
const coverOf = (content) => {
  const overview = content?.worldOverview;
  const thumbnail = overview?.thumbnail;
  if (typeof thumbnail === 'string') return thumbnail;
  if (!thumbnail || typeof thumbnail !== 'object' || thumbnail.mediaId === undefined) return null;

  const list = overview.mediaList;
  const entry = Array.isArray(list)
    ? list.find((item) => item && item.id === thumbnail.mediaId)
    : list?.[thumbnail.mediaId];
  return typeof entry?.data === 'string' ? entry.data : null;
};

// The strings that carry the mark: the cover, then the largest eligible images, ties in first-appearance order.
const markedStrings = async (content) => {
  const infos = new Map();
  for (const value of imageStrings(content)) infos.set(value, await imageInfo(value));

  const cover = coverOf(content);
  const coverInfo = cover && infos.get(cover);
  const chosen = coverInfo && !coverInfo.animated ? [cover] : [];

  const eligible = [...infos]
    .filter(([value, info]) => value !== cover && info && !info.animated && info.pixels >= WORLD_MIN_PIXELS)
    .map(([value, info], order) => ({ value, pixels: info.pixels, order }))
    .sort((a, b) => b.pixels - a.pixels || a.order - b.order);
  return [...chosen, ...eligible.slice(0, WORLD_MARKED_EXTRAS).map(({ value }) => value)];
};

// The lossless WebP of one marked image, as a data URL.
const markWorldImage = async (value, mark) => {
  const { data, info } = await sharp(Buffer.from(DATA_URL.exec(value)[1], 'base64'))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const marked = await pool.markLayer({ width: info.width, height: info.height, data: new Uint8ClampedArray(data) }, mark, null);
  const webp = await sharp(Buffer.from(marked.data.buffer, marked.data.byteOffset, marked.data.length), {
    raw: { width: marked.width, height: marked.height, channels: info.channels }
  }).webp({ lossless: true }).toBuffer();
  return `data:image/webp;base64,${webp.toString('base64')}`;
};

// The content with each string in `replacements` swapped. A Media Entry whose data was marked loses its
// `hash` (the client re-hashes an entry without one) and takes the new type.
const replaceStrings = (value, replacements) => {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => replaceStrings(item, replacements));
  if (!value || typeof value !== 'object') return value;

  const out = {};
  for (const [key, item] of Object.entries(value)) out[key] = replaceStrings(item, replacements);
  if (typeof value.data === 'string' && replacements.has(value.data)) {
    delete out.hash;
    if (value.kind === 'image' || 'type' in value) out.type = 'image/webp';
  }
  return out;
};

const processWorld = async (content, mark) => {
  const sources = await markedStrings(content);
  const replacements = new Map(await Promise.all(sources.map(async (source) => [source, await markWorldImage(source, mark)])));
  return replaceStrings(content, replacements);
};

// Hash of what shapes the output, so a change to the mark or the scramble retires every older copy.
const PROCESSING_VERSION = crypto.createHash('sha256')
  .update(SEED_PURPOSE)
  .update(WORLD_VERSION_SALT)
  .update(fs.readFileSync(require.resolve('./watermark')))
  .update(fs.readFileSync(require.resolve('./scramble')))
  .digest('hex')
  .slice(0, 12);

const CACHE_PREFIX = 'processed-';
const cachePrefix = (listingId) => `${CACHE_PREFIX}${listingId}-`;
const currentPrefix = (listing) => `${cachePrefix(listing.id)}v${PROCESSING_VERSION}-r${listing.revision}-`;
const cacheName = (listing, userId) => `${currentPrefix(listing)}${userId}.json`;

/** Remove every cached copy of one listing. */
const clearListingCache = (listingId) => deleteSupporterFilesWithPrefix(cachePrefix(listingId));

/** Remove every cached copy made for one account, across all listings. */
const clearAccountCache = (userId) =>
  deleteSupporterFilesWithPrefix(CACHE_PREFIX, { keep: (file) => !file.endsWith(`-${userId}.json`) });

/**
 * @param {Object} request
 * @param {string} request.userId - The account the copy is made for
 * @param {Object} request.listing - The listing row: `{ id, kind, revision }`
 * @param {Object} request.content - The listing's content
 * @param {boolean} [request.cached=true] - Keep a Mascot's result in the private area per account and
 *   revision; false for content that is not the listing's live revision. A world is never cached.
 * @returns {Promise<Object>} The content this account receives
 */
const processForAccount = async ({ userId, listing, content, cached = true }) => {
  if (listing.kind !== MASCOT_KIND) return processWorld(content, WatermarkMark.markFor(userId));

  const run = () => processValue(content, WatermarkMark.markFor(userId), seedFor(userId, listing.id, listing.revision));
  if (!cached) return run();

  const name = cacheName(listing, userId);
  const hit = await readSupporterFile(name);
  if (hit) {
    // A concurrent request may be mid-write; an unreadable file is a miss.
    try {
      return JSON.parse(hit.toString('utf8'));
    } catch {}
  }

  const processed = await run();
  // A miss means the revision or processing version moved, or this account is new; older copies go.
  await deleteSupporterFilesWithPrefix(cachePrefix(listing.id), { keep: (file) => file.startsWith(currentPrefix(listing)) });
  await saveSupporterFile(name, JSON.stringify(processed));
  return processed;
};

module.exports = { processForAccount, clearListingCache, clearAccountCache, PROCESSING_VERSION, CACHE_PREFIX };
