/**
 * Linked images in world content: an image slot that holds an http(s) link instead of embedded bytes.
 * The slots mirror the client's `remoteWorldImages` and its Media tab: world thumbnail, entity and location
 * galleries, Map Background gallery, Custom Image Backdrops and Dictionary covers.
 */

const REMOTE = /^https?:\/\//i;
const isRemote = (value) => typeof value === 'string' && REMOTE.test(value.trim());

// A gallery element is a data string on old records, or `{ data }`.
const galleryData = (raw) => (raw && typeof raw === 'object' ? raw.data : raw);

const gallery = (holder) => {
  if (Array.isArray(holder.images)) return holder.images.map(galleryData);
  const legacy = holder.image ?? holder.backgroundImage;
  return legacy ? [legacy] : [];
};

const named = (kind, item, index) => `${kind} ${item && item.name ? `"${item.name}"` : `#${index + 1}`}`;

/**
 * @param {Object} content - A world's content
 * @returns {Array<{ where: string, url: string }>} Each linked image and where it sits, in content order
 */
const linkedImageLocations = (content) => {
  const found = [];
  const check = (where, value) => {
    if (isRemote(value)) found.push({ where, url: value.trim() });
  };
  const world = content && typeof content === 'object' ? content : {};

  check('World thumbnail', world.worldOverview?.thumbnail);
  (Array.isArray(world.entities) ? world.entities : []).forEach((entity, i) => {
    if (!entity || typeof entity !== 'object') return;
    gallery(entity).forEach((data, n) => check(`${named('Entity', entity, i)}, image ${n + 1}`, data));
  });
  (Array.isArray(world.locations) ? world.locations : []).forEach((location, i) => {
    if (!location || typeof location !== 'object') return;
    gallery(location).forEach((data, n) => check(`${named('Location', location, i)}, image ${n + 1}`, data));
  });
  (world.worldOverview?.mapBackground?.images ?? []).forEach((img, n) => check(`Map Background, image ${n + 1}`, galleryData(img)));
  (Array.isArray(world.bodies) ? world.bodies : []).forEach((body, i) => {
    if (body?.backdrop?.kind === 'image') check(`${named('Body', body, i)}, backdrop`, body.backdrop.image?.data);
  });
  (Array.isArray(world.dictionaries) ? world.dictionaries : []).forEach((dictionary, i) => {
    if (dictionary) check(`${named('Dictionary', dictionary, i)}, cover image`, dictionary.thumbnail);
  });

  return found;
};

/**
 * The 400 body for a Supporter-only world that links images, or null when it holds none.
 *
 * @param {Object} content - A world's content
 */
const linkedImageRefusal = (content) => {
  const linkedImages = linkedImageLocations(content);
  if (!linkedImages.length) return null;
  return {
    success: false,
    code: 'SUPPORTER_LINKED_IMAGES',
    error: `A Supporter-only world cannot link images. Embed these first: ${linkedImages.map((l) => l.where).join('; ')}`,
    linkedImages
  };
};

module.exports = { linkedImageLocations, linkedImageRefusal };
