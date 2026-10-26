const db = require('../config/db');
const Changelog = require('./Changelog');
const Compatibility = require('./Compatibility');
const { parseModels } = require('../utils/modelList');
const { promotePendingFiles, pendingFilesExist, deletePendingFile, deleteThumbnail } = require('../utils/fileStorage');

/**
 * Pending update model: an author's edit to an approved listing, held until a mod decides on it.
 *
 * Players keep the approved listing, files included, the whole time. Approval writes the held fields onto
 * the listing and moves the held files over the live ones; rejection and discard only delete the held
 * row and files.
 */

/** The worlds columns a pending update may hold, and how each reads in `pending_update.fields`. */
const FIELD_READERS = Object.freeze({
  name: (value) => value,
  description: (value) => value,
  // A string that is not JSON is one tag, as `World.update` stores it.
  tags: (value) => {
    if (typeof value !== 'string') return value || [];
    try {
      return JSON.parse(value);
    } catch {
      return [value];
    }
  },
  models: (value) => parseModels(value),
  model_license: (value) => (value ? JSON.parse(value) : null),
  visibility: (value) => value
});

/** Held columns applied at approval but never listed: each follows the content it was derived from. */
const DERIVED_FIELDS = Object.freeze(['app_version']);

const HELD_FIELDS = Object.freeze([...Object.keys(FIELD_READERS), ...DERIVED_FIELDS]);

const parseJson = (value) => (value === null ? null : JSON.parse(value));

// A null side column means that edit is not part of the update.
const parseRow = (row) => (row ? {
  ...row,
  fields: JSON.parse(row.fields),
  changelog: JSON.parse(row.changelog),
  dependencies: parseJson(row.dependencies),
  compatibility: parseJson(row.compatibility)
} : null);

// Required on use: Dependency reads World, which reads this model.
const Dependency = () => require('./Dependency');

/** The ids that still name a listing. A listing deleted while the update waited drops out. */
const existingIds = (ids) => {
  const exists = db.prepare('SELECT 1 FROM worlds WHERE id = ?');
  return ids.filter((id) => exists.get(id));
};

/** Whether two id lists hold the same set. The stored order follows the declaration date, not the list. */
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * Replay held changelog operations in order. A create past the cap is skipped; an edit or delete whose
 * entry is gone changes nothing. An op only ever names this listing's entries: the routes check that.
 *
 * @param {string} worldId - World ID
 * @param {Array<Object>} ops - `{ op, id, title?, body?, date? }` in call order
 */
const replayChangelog = (worldId, ops) => {
  for (const op of ops) {
    if (op.op === 'create') {
      if (Changelog.countFor(worldId) >= Changelog.MAX_ENTRIES) continue;
      Changelog.create({ id: op.id, world_id: worldId, title: op.title, body: op.body, entry_date: op.date });
    }
    if (op.op === 'edit') Changelog.update(op.id, { title: op.title, body: op.body, entry_date: op.date });
    if (op.op === 'delete') Changelog.delete(op.id);
  }
};

/** A held value read the way the listing payload reads it, for an equality check and for display. */
const readField = (name, value) => {
  try {
    return FIELD_READERS[name](value);
  } catch {
    return null;
  }
};

const PendingUpdate = {
  HELD_FIELDS,

  /**
   * The pending update on a listing.
   *
   * @param {string} worldId - World ID
   * @returns {Object|null} The row with `fields` and `changelog` parsed, or null when none waits
   */
  findByWorldId: (worldId) => parseRow(db.prepare('SELECT * FROM pending_updates WHERE world_id = ?').get(worldId)),

  /**
   * Create the pending update, or merge an edit into the one that waits. A sent field replaces its held
   * value and an omitted one keeps it; `queued_at` never moves, so a re-edit keeps its place. A sent side
   * edit replaces its held value; changelog operations append.
   *
   * @param {string} worldId - World ID
   * @param {Object} edit - `{ fields, contentFile, thumbnailFile, dependencies, compatibility, spoiler,
   *   changelog }`, the files already in the pending directory
   * @returns {Object} `{ update, replacedFiles }`: the merged row, and the held files it no longer points at
   */
  submit: db.transaction((worldId, {
    fields = {}, contentFile = null, thumbnailFile = null, dependencies, compatibility, spoiler, changelog = []
  }) => {
    const now = new Date().toISOString();
    const before = PendingUpdate.findByWorldId(worldId);
    const replacedFiles = [];

    if (before && contentFile && before.content_file) replacedFiles.push(before.content_file);
    if (before && thumbnailFile && before.thumbnail_file) replacedFiles.push(before.thumbnail_file);

    db.prepare(`
      INSERT INTO pending_updates (
        world_id, fields, dependencies, compatibility, spoiler, changelog, content_file, thumbnail_file,
        submitted_at, queued_at
      )
      VALUES (
        @worldId, @fields, @dependencies, @compatibility, @spoiler, @changelog, @contentFile, @thumbnailFile,
        @now, @now
      )
      ON CONFLICT (world_id) DO UPDATE SET
        fields = @fields,
        dependencies = COALESCE(@dependencies, dependencies),
        compatibility = COALESCE(@compatibility, compatibility),
        spoiler = COALESCE(@spoiler, spoiler),
        changelog = @changelog,
        content_file = COALESCE(@contentFile, content_file),
        thumbnail_file = COALESCE(@thumbnailFile, thumbnail_file),
        submitted_at = @now
    `).run({
      worldId,
      fields: JSON.stringify({ ...(before ? before.fields : {}), ...fields }),
      dependencies: dependencies === undefined ? null : JSON.stringify(dependencies),
      compatibility: compatibility === undefined ? null : JSON.stringify(compatibility),
      spoiler: spoiler === undefined ? null : Number(spoiler),
      changelog: JSON.stringify([...(before ? before.changelog : []), ...changelog]),
      contentFile,
      thumbnailFile,
      now
    });

    return { update: PendingUpdate.findByWorldId(worldId), replacedFiles };
  }),

  /**
   * Take the pending update off a listing. Conditional on it still being there, so of two decisions only
   * one gets the row.
   *
   * @param {string} worldId - World ID
   * @returns {Object|null} The removed row, or null when none waited
   */
  claim: (worldId) => parseRow(db.prepare('DELETE FROM pending_updates WHERE world_id = ? RETURNING *').get(worldId)),

  /**
   * Drop a pending update, for a rejection or the author's discard. Live files are never touched.
   *
   * @param {string} worldId - World ID
   * @returns {Promise<Object|null>} The removed row, or null when none waited
   */
  drop: async (worldId) => {
    const update = PendingUpdate.claim(worldId);
    if (update) await PendingUpdate.deleteFiles([update]);
    return update;
  },

  /**
   * Apply a pending update to its listing: every held field, side edit and changelog operation, and both
   * files. At most one revision raise, with `updated_at`.
   *
   * @param {string} worldId - World ID
   * @returns {Promise<Object|null>} The updated world row, or null when no update waited
   */
  approve: async (worldId) => {
    // Required here: World reads this model for its payloads.
    const World = require('./World');
    const before = World.findById(worldId);

    const applied = db.transaction(() => {
      const waiting = PendingUpdate.findByWorldId(worldId);
      if (!waiting) return null;
      // Checked before the claim, so a lost held file never applies half an update.
      if (!pendingFilesExist(waiting)) throw new Error(`The held files of the update to ${worldId} are missing`);

      const update = PendingUpdate.claim(worldId);
      if (!update) return null;

      // Each part applies with its live route's side effects: only what a download installs raises the revision.
      const { visibility, ...data } = update.fields;
      if (update.thumbnail_file) {
        data.thumbnail_file = update.thumbnail_file;
        data.placeholder = 0;
      }

      const dependenciesChanged = update.dependencies
        ? Dependency().replaceFor(worldId, existingIds(update.dependencies))
        : false;
      if (Object.keys(data).length > 0 || update.content_file || dependenciesChanged) World.update(worldId, data);
      if (visibility !== undefined) World.setVisibility(worldId, visibility);
      if (update.spoiler !== null) World.updateSpoilerStatus(worldId, update.spoiler);
      if (update.compatibility) Compatibility.replaceFor(worldId, existingIds(update.compatibility));
      replayChangelog(worldId, update.changelog);
      return update;
    })();

    if (!applied) return null;

    // In the same tick as the commit, so nothing reads the new row before its files are in place. The old
    // thumbnail goes only once the new one is live.
    let moved = false;
    try {
      promotePendingFiles({
        content: applied.content_file,
        contentTarget: before.content_file || `${worldId}.json`,
        thumbnail: applied.thumbnail_file
      });
      moved = true;
    } catch (error) {
      console.error(`Approved the update to ${worldId} but could not move its files:`, error);
    }

    if (moved && applied.thumbnail_file && before.thumbnail_file) await deleteThumbnail(before.thumbnail_file);

    return World.findById(worldId);
  },

  /**
   * Delete the held files of these pending updates. Reaches only the pending directory.
   *
   * @param {Array<Object>} updates - Rows carrying `content_file` and `thumbnail_file`
   */
  deleteFiles: async (updates) => {
    for (const update of updates) {
      await deletePendingFile(update.content_file);
      await deletePendingFile(update.thumbnail_file);
    }
  },

  /**
   * The held files of every pending update on these listings, read before the listings are deleted.
   *
   * @param {string[]} worldIds - World IDs
   * @returns {Array<Object>} `{ content_file, thumbnail_file }` per update
   */
  filesFor: (worldIds) => {
    if (worldIds.length === 0) return [];
    return db
      .prepare(`SELECT content_file, thumbnail_file FROM pending_updates WHERE world_id IN (${worldIds.map(() => '?').join(', ')})`)
      .all(...worldIds);
  },

  /**
   * Updates waiting for a mod: contest entries first, then the longest-waiting.
   *
   * @returns {Array<Object>} Rows with the listing's, the author's and the contest's columns joined in
   */
  queue: () => db.prepare(`
    SELECT p.world_id AS id, p.queued_at, w.kind, w.name, w.created_at, w.contest_event_id,
           w.quarantined_at, w.quarantine_expires_at,
           e.title AS contest_title,
           u.id AS author_id, u.username AS author_username, u.avatar_file AS author_avatar_file,
           u.account_type AS author_account_type
    FROM pending_updates p
    JOIN worlds w ON w.id = p.world_id
    LEFT JOIN users u ON u.id = w.author_id
    LEFT JOIN events e ON e.id = w.contest_event_id
    ORDER BY (w.contest_event_id IS NULL), p.queued_at ASC, p.world_id ASC
  `).all(),

  /** How many updates `queue` holds, without reading them. */
  count: () => db.prepare('SELECT COUNT(*) AS count FROM pending_updates').get().count,

  /**
   * What the author and staff are shown of a pending update: each changed field beside its approved
   * value, the changelog operations, whether content changed, and where the held thumbnail is served.
   *
   * @param {Object} world - The live world row, columns as stored
   * @param {Object} update - The pending update row
   * @returns {Object} `{ fields, changelog, content_changed, thumbnail_url? }`; the side edits list in
   *   `fields` as `spoiler`, `required_dependencies` and `compatible_worlds`
   */
  payloadFor: (world, update) => {
    const fields = {};
    for (const name of Object.keys(FIELD_READERS)) {
      if (!(name in update.fields)) continue;
      const approved = readField(name, world[name]);
      const pending = readField(name, update.fields[name]);
      if (JSON.stringify(approved) !== JSON.stringify(pending)) fields[name] = { approved, pending };
    }

    if (update.spoiler !== null && Boolean(update.spoiler) !== Boolean(world.spoiler)) {
      fields.spoiler = { approved: Boolean(world.spoiler), pending: Boolean(update.spoiler) };
    }
    if (update.dependencies) {
      const approved = Dependency().sourceIdsFor(world.id);
      if (!sameSet(approved, update.dependencies)) fields.required_dependencies = { approved, pending: update.dependencies };
    }
    if (update.compatibility) {
      const approved = Compatibility.worldIdsFor(world.id);
      if (!sameSet(approved, update.compatibility)) fields.compatible_worlds = { approved, pending: update.compatibility };
    }

    return {
      fields,
      changelog: update.changelog,
      content_changed: Boolean(update.content_file),
      ...(update.thumbnail_file ? { thumbnail_url: `/api/reviews/${world.id}/thumbnail` } : {})
    };
  }
};

module.exports = PendingUpdate;
