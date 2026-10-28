const crypto = require('crypto');
const fs = require('fs');
const sharp = require('sharp');
const WatermarkMark = require('../models/WatermarkMark');
const { embed } = require('./watermark');
const { scramble } = require('./scramble');
const {
  saveSupporterFile, readSupporterFile, deleteSupporterFilesWithPrefix
} = require('./fileStorage');

/**
 * The per-account step the gated content route runs on a listing's content before it leaves the server.
 * Every base64 image data URL in the content is watermarked with the account's mark, scrambled with the
 * account's seed, and sent as `{ dataUrl, seed, version, sourceWidth, sourceHeight }` in the same place.
 * Anything else passes through unchanged.
 */

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
  const marked = embed({ width, height, data: new Uint8ClampedArray(decoded.data) }, mark);
  const { data, width: paddedWidth, height: paddedHeight, ...format } = scramble({ width, height, data: marked.data }, seed);
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

// Hash of what shapes the output, so a change to the mark or the scramble retires every older copy.
const PROCESSING_VERSION = crypto.createHash('sha256')
  .update(SEED_PURPOSE)
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
 * @param {Object} request.listing - The listing row: `{ id, revision }`
 * @param {Object} request.content - The listing's content
 * @param {boolean} [request.cached=true] - Keep the result in the private area per account and revision;
 *   false for content that is not the listing's live revision
 * @returns {Promise<Object>} The content this account receives
 */
const processForAccount = async ({ userId, listing, content, cached = true }) => {
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

module.exports = { processForAccount, clearListingCache, clearAccountCache, PROCESSING_VERSION };
