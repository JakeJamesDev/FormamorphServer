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
 * place. Any other kind: 5 images carry the mark (the cover, the characters, then the largest backdrops), as
 * plain lossless WebP data URLs, unscrambled; every other image passes through byte for byte. Anything else
 * passes through.
 */

const MASCOT_KIND = 'mascot';
// A world marks this many images: the cover, the characters, then the largest backdrops.
const WORLD_MARKED_IMAGES = 5;
// The watermark survives screenshots and re-encodes from about this size (pixels, width x height).
const WORLD_MIN_PIXELS = 310000;
// Part of the processing version, so a change to the world path retires every older copy.
const WORLD_VERSION_SALT = 'world-characters-first-v1';

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

/** The string's pixel count and whether it is animated, from its header alone; null when it will not read or is a vector. */
const imageInfo = async (value) => {
  const match = DATA_URL.exec(value);
  if (!match) return null;
  try {
    const { width, height, pages, format } = await sharp(Buffer.from(match[1], 'base64')).metadata();
    if (!width || !height || format === 'svg') return null;
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

const mediaEntryOf = (list, id) => (Array.isArray(list)
  ? list.find((item) => item && item.id === id)
  : list?.[id]);

// The cover: `worldOverview.thumbnail`, a data URL or a `{ mediaId }` into the Media List. Null when neither.
const coverOf = (content) => {
  const overview = content?.worldOverview;
  const thumbnail = overview?.thumbnail;
  if (typeof thumbnail === 'string') return thumbnail;
  if (!thumbnail || typeof thumbnail !== 'object' || thumbnail.mediaId === undefined) return null;

  const entry = mediaEntryOf(overview.mediaList, thumbnail.mediaId);
  return typeof entry?.data === 'string' ? entry.data : null;
};

const hasRule = (item) => Array.isArray(item?.requires) && item.requires.length > 0;
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = (value) => (typeof value === 'string' && value ? value : undefined);

// An image entry's data; undefined for no entry, a sound or a Layered Image.
const entryImageData = (entry) => (isRecord(entry) && entry.kind !== 'layered' && entry.kind !== 'sound'
  ? nonEmptyString(entry.data) : undefined);
const mediaImageData = (list, id) => entryImageData(mediaEntryOf(list, id));

// A Layered Image's base Layer: the first Layer that has a Variant, which sizes the canvas.
const baseLayerIndex = (layers) => layers.findIndex((layer) => layer.variants.length > 0);

// A rig as `{ layers: [{ variants: [{ data, requires }] }] }`, each Variant's data read by `dataOf`.
const rigLayers = (layers, dataOf) => (Array.isArray(layers) ? layers : []).filter(isRecord).map((layer) => ({
  variants: (Array.isArray(layer.variants) ? layer.variants : []).filter(isRecord)
    .map((variant) => ({ data: dataOf(variant), requires: variant.requires }))
}));

// An embedded Layered Image's layers; Variants without data drop, as the client reads them.
const embeddedRigLayers = (layers) => rigLayers(layers, (variant) => nonEmptyString(variant.data))
  .map((layer) => ({ variants: layer.variants.filter((variant) => variant.data) }));

// One gallery slot as `{ data }` or `{ layers }`, with its rule; null when it draws nothing, so it is no slot.
const resolveSlot = (raw, list) => {
  if (typeof raw === 'string') return raw ? { data: raw } : null;
  if (!isRecord(raw)) return null;
  const rule = { requires: raw.requires };
  let layers;
  if (nonEmptyString(raw.mediaId)) {
    const entry = mediaEntryOf(list, raw.mediaId);
    if (entry?.kind !== 'layered') {
      const data = entryImageData(entry);
      return data ? { data, ...rule } : null;
    }
    layers = rigLayers(entry.layers, (variant) => mediaImageData(list, variant.mediaId));
  } else if (isRecord(raw.layered) && Array.isArray(raw.layered.layers)) {
    layers = embeddedRigLayers(raw.layered.layers);
  } else {
    const data = nonEmptyString(raw.data);
    return data ? { data, ...rule } : null;
  }
  // A rig draws when the Variant that sizes its canvas names an image.
  const base = baseLayerIndex(layers);
  return base >= 0 && layers[base].variants[0].data ? { layers, ...rule } : null;
};

// The entity's gallery slots that draw, the legacy single-portrait field included.
const gallerySlots = (entity, list) => {
  const raw = Array.isArray(entity.images) ? entity.images : entity.image ? [entity.image] : [];
  return raw.map((slot) => resolveSlot(slot, list)).filter(Boolean);
};

// An entity's start picture as approximated: first ruleless slot, through its base Layer's first ruleless Variant.
const approximatePicture = (entity, list) => {
  const slot = gallerySlots(entity, list).find((item) => !hasRule(item));
  if (!slot || slot.data) return slot?.data;
  return slot.layers[baseLayerIndex(slot.layers)].variants.find((variant) => variant.data && !hasRule(variant))?.data;
};

// Media List ids an entity owns: flat gallery images and base Layer Variants, never overlays or embedded images.
const ownMediaIds = (entity, list) => {
  const slots = Array.isArray(entity.images) ? entity.images : entity.image ? [entity.image] : [];
  const ids = new Set();
  for (const slot of slots) {
    const id = isRecord(slot) ? nonEmptyString(slot.mediaId) : undefined;
    if (!id) continue;
    const entry = mediaEntryOf(list, id);
    if (entry?.kind !== 'layered') {
      ids.add(id);
      continue;
    }
    // Each Variant's `data` holds its Media List id here.
    const layers = rigLayers(entry.layers, (variant) => nonEmptyString(variant.mediaId));
    const base = baseLayerIndex(layers);
    if (base >= 0) layers[base].variants.forEach((variant) => variant.data && ids.add(variant.data));
  }
  return ids;
};

// The image of a pick, or undefined when the entity does not own that Media List image entry.
const pickedPicture = (entity, pick, list) => (pick && ownMediaIds(entity, list).has(pick.mediaId)
  ? mediaImageData(list, pick.mediaId) : undefined);

// Each entity's candidate images in priority order; the first eligible one is its image.
const entityCandidates = (entity, pick, list) => [pickedPicture(entity, pick, list), approximatePicture(entity, list)].filter(Boolean);

// Entities in World Editor order: folders by `parentId`, siblings by `order`, falling back to array index.
const entitiesInEditorOrder = (content) => {
  const entities = (Array.isArray(content?.entities) ? content.entities : []).filter(isRecord);
  const groups = (Array.isArray(content?.entityGroups) ? content.entityGroups : []).filter(isRecord);
  const known = new Set(groups.map((group) => group.id));
  const parentOf = (ref) => (ref != null && known.has(ref) ? ref : null);
  const visited = new Set();
  const visit = (parentId) => {
    const children = [
      ...groups.map((group, i) => ({ group, sort: group.order ?? i })).filter(({ group }) => parentOf(group.parentId) === parentId),
      ...entities.map((entity, i) => ({ entity, sort: entity.order ?? i })).filter(({ entity }) => parentOf(entity.groupId) === parentId)
    ].sort((a, b) => a.sort - b.sort);
    return children.flatMap(({ group, entity }) => {
      if (entity) return [entity];
      if (visited.has(group.id)) return [];
      visited.add(group.id);
      return visit(group.id);
    });
  };
  return visit(null);
};

// Image strings that appear only as Variants above a rig's base Layer. A mark there does not survive stacking.
const overlayOnlyStrings = (content) => {
  const list = content?.worldOverview?.mediaList;
  const plain = new Set();
  const overlay = new Set();
  const plainIds = new Set();
  const overlayIds = new Set();

  const walk = (value, inOverlay) => {
    if (typeof value === 'string') {
      if (DATA_URL.test(value)) (inOverlay ? overlay : plain).add(value);
    } else if (Array.isArray(value)) {
      value.forEach((item) => walk(item, inOverlay));
    } else if (isRecord(value)) {
      if (typeof value.mediaId === 'string') (inOverlay ? overlayIds : plainIds).add(value.mediaId);
      const layers = Array.isArray(value.layers) && value.layers.every(isRecord) && value.layers.some((layer) => Array.isArray(layer.variants))
        ? value.layers : null;
      // A Media List rig counts every Variant toward its base Layer; an embedded one only those with data.
      const base = !layers ? -1 : baseLayerIndex(value.kind === 'layered' ? rigLayers(layers, () => undefined) : embeddedRigLayers(layers));
      for (const [key, item] of Object.entries(value)) {
        if (key === 'layers' && layers) layers.forEach((layer, i) => walk(layer, inOverlay || i !== base));
        else walk(item, inOverlay);
      }
    }
  };

  // An image entry's data counts where its id is used, so image entries stay out of the walk.
  const entries = !list || typeof list !== 'object' ? [] : Array.isArray(list) ? list : Object.values(list);
  const imageEntries = entries.filter((entry) => entryImageData(entry));
  const imageEntrySet = new Set(imageEntries);
  const otherEntries = entries.filter((entry) => !imageEntrySet.has(entry));
  walk({ ...content, worldOverview: { ...content?.worldOverview, mediaList: otherEntries } }, false);
  for (const entry of imageEntries) {
    (overlayIds.has(entry.id) && !plainIds.has(entry.id) ? overlay : plain).add(entry.data);
  }
  return new Set([...overlay].filter((value) => !plain.has(value)));
};

// The lossless WebP of one marked image, as a data URL, or null when the body does not decode.
const markWorldImage = async (value, mark) => {
  let decoded;
  try {
    decoded = await sharp(Buffer.from(DATA_URL.exec(value)[1], 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch {
    return null;
  }
  const { data, info } = decoded;
  const marked = await pool.markLayer({ width: info.width, height: info.height, data: new Uint8ClampedArray(data) }, mark, null);
  const webp = await sharp(Buffer.from(marked.data.buffer, marked.data.byteOffset, marked.data.length), {
    raw: { width: marked.width, height: marked.height, channels: info.channels }
  // Effort 0: 3x faster than the default on the API box, about 6% larger, same pixels.
  }).webp({ lossless: true, effort: 0 }).toBuffer();
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

// The cover when markable, then each entity's image in World Editor order, then the largest remaining images.
// An image that fails to decode passes through, and the next candidate takes its place.
const processWorld = async (content, mark, picks = []) => {
  const pickOf = new Map(picks.map((pick) => [pick.entityId, pick]));
  const infos = new Map();
  for (const value of imageStrings(content)) infos.set(value, await imageInfo(value));
  const eligible = (value) => {
    const info = infos.get(value);
    return !!info && !info.animated && info.pixels >= WORLD_MIN_PIXELS;
  };

  const replacements = new Map();
  const tryMark = async (value) => {
    const marked = await markWorldImage(value, mark);
    if (marked) replacements.set(value, marked);
    return !!marked;
  };

  const cover = coverOf(content);
  const coverInfo = cover && infos.get(cover);
  if (coverInfo && !coverInfo.animated) await tryMark(cover);

  const list = content?.worldOverview?.mediaList;
  for (const entity of entitiesInEditorOrder(content)) {
    if (replacements.size === WORLD_MARKED_IMAGES) break;
    const value = entityCandidates(entity, pickOf.get(entity.id), list).find(eligible);
    // An image already chosen counts once; the next entity takes the free mark.
    if (value && !replacements.has(value)) await tryMark(value);
  }

  const overlays = overlayOnlyStrings(content);
  const ranked = [...infos.keys()]
    .map((value, order) => ({ value, order }))
    .filter(({ value }) => value !== cover && eligible(value) && !overlays.has(value) && !replacements.has(value))
    .sort((a, b) => infos.get(b.value).pixels - infos.get(a.value).pixels || a.order - b.order);
  for (const { value } of ranked) {
    if (replacements.size === WORLD_MARKED_IMAGES) break;
    await tryMark(value);
  }
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
 * @param {Array<Object>} [request.picks] - A world's stored `{ entityId, mediaId }` picks for this content
 * @returns {Promise<Object>} The content this account receives
 */
const processForAccount = async ({ userId, listing, content, cached = true, picks = [] }) => {
  if (listing.kind !== MASCOT_KIND) return processWorld(content, WatermarkMark.markFor(userId), picks);

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
