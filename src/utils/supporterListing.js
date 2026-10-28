const db = require('../config/db');
const World = require('../models/World');
const AuditLog = require('../models/AuditLog');
const { deleteWorldContent, deleteThumbnail } = require('./fileStorage');

/**
 * Create a listing Supporter-only and pinned in one transaction, so no reader ever sees it public.
 *
 * The caller has already written the content to the private area. On a failure the row rolls back and
 * both files are removed.
 *
 * @param {Object} row - What `World.create` takes, `id` included
 * @param {string} contentFile - The stored content file, already in the private area
 * @param {string} thumbnailFile - The stored thumbnail file
 * @param {Object} actor - The admin publishing it, for the audit log
 */
async function createSupporterListing(row, contentFile, thumbnailFile, actor) {
  try {
    db.transaction(() => {
      World.create(row, contentFile, thumbnailFile);
      // The content is already private, so the move inside is a no-op.
      World.setSupporterOnly(row.id, true);
      World.pin(row.id);
    })();
  } catch (error) {
    await deleteWorldContent(contentFile).catch(() => {});
    await deleteThumbnail(thumbnailFile).catch(() => {});
    throw error;
  }

  for (const action of ['listing_supporter_only', 'listing_pinned']) {
    AuditLog.tryRecord({ action, actor, targetKind: row.kind, targetName: row.name, targetId: row.id });
  }
}

module.exports = { createSupporterListing };
