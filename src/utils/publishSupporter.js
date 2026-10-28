const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');
const World = require('../models/World');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { isStaff } = require('../config/roles');
const { rulesFor } = require('../config/kinds');
const { MODERATION_STATES } = require('../config/listingReview');
const { appVersionOf } = require('./appVersion');
const { contentSizeError } = require('./contentSize');
const { saveWorldContent, saveThumbnail, deleteWorldContent, deleteThumbnail } = require('./fileStorage');

const KIND = 'mascot';

/** The data of the first chunk named `fourCC` in a RIFF WebP, or null. */
function webpChunk(bytes, fourCC) {
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') return null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const name = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) return null;
    if (name === fourCC) return bytes.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  return null;
}

/**
 * The Mascot card a Mascot tab export carries in its XMP chunk.
 *
 * @param {Buffer} bytes - The exported `.webp`
 * @returns {Object} The parsed card
 */
function readMascotCard(bytes) {
  const chunk = webpChunk(bytes, 'XMP ');
  if (!chunk) throw new Error('This file is not a Mascot card. Export it from the Mascot tab.');
  let card;
  try {
    card = JSON.parse(chunk.toString('utf8'));
  } catch {
    throw new Error('This Mascot card is corrupted.');
  }
  if (!card || card.formamorphKind !== KIND || !Array.isArray(card.images)) {
    throw new Error('This file is not a Mascot card. Export it from the Mascot tab.');
  }
  return card;
}

/** A WebP data URL of the image, re-encoded so no metadata, the card included, rides along. */
async function cleanThumbnail(bytes) {
  const encoded = await sharp(bytes).webp().toBuffer();
  return `data:image/webp;base64,${encoded.toString('base64')}`;
}

/**
 * Publish a Mascot card as a Supporter-only, pinned listing in one step.
 *
 * The content goes straight to the private area, and the row is created flagged and pinned in one
 * transaction, so no reader ever sees the listing public.
 *
 * @param {Object} options
 * @param {Buffer} options.card - The Mascot tab export
 * @param {Buffer} [options.thumbnail] - The listing image; the card's Initial look when absent
 * @param {string} options.author - The staff username the listing is published under
 * @param {string} [options.name] - The listing name; the card's name when absent
 * @param {string} [options.description]
 * @returns {Promise<Object>} The created row
 */
async function publishSupporter({ card: cardBytes, thumbnail, author, name, description = '' }) {
  const user = User.findByUsername(author);
  if (!user) throw new Error(`No account is named "${author}".`);
  if (!isStaff(user)) throw new Error(`"${author}" is not a staff account.`);

  const card = readMascotCard(cardBytes);
  const listingName = (name || card.name || '').trim();
  if (!listingName) throw new Error('The card has no name. Pass --name.');

  const rules = rulesFor(KIND);
  const tooLarge = contentSizeError(card, rules);
  if (tooLarge) throw new Error(tooLarge);

  const id = uuidv4();
  const thumbnailFile = await saveThumbnail(await cleanThumbnail(thumbnail || cardBytes));
  let contentFile = null;
  try {
    contentFile = await saveWorldContent(id, card, { supporterOnly: true });
    db.transaction(() => {
      World.create({
        id,
        name: listingName,
        description,
        author_id: user.id,
        tags: [],
        kind: KIND,
        app_version: rules.stampsAppVersion ? appVersionOf(card) : null,
        moderation_state: MODERATION_STATES.APPROVED
      }, contentFile, thumbnailFile);
      // The content is already private, so the move inside is a no-op.
      World.setSupporterOnly(id, true);
      World.pin(id);
    })();
  } catch (error) {
    if (contentFile) await deleteWorldContent(contentFile).catch(() => {});
    await deleteThumbnail(thumbnailFile).catch(() => {});
    throw error;
  }

  for (const action of ['listing_supporter_only', 'listing_pinned']) {
    AuditLog.tryRecord({ action, actor: user, targetKind: KIND, targetName: listingName, targetId: id });
  }
  return World.findById(id);
}

module.exports = { publishSupporter, readMascotCard };
