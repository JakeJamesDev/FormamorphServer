const db = require('../config/db');

// Server-only Supporter mark picks: per entity, the Media List image its start picture uses. They belong to
// the content: new content replaces or clears them, a metadata-only write leaves them.

// Bounds a client cannot talk past: one pick per entity, ids are short strings.
const MAX_PICKS = 5000;
const MAX_ID_LENGTH = 200;

const idOf = (value) => (typeof value === 'string' && value && value.length <= MAX_ID_LENGTH ? value : null);

/**
 * The usable picks of a request field. A non-array gives none; a bad entry drops alone. Never throws.
 *
 * @param {*} raw - The request's `markPicks`
 * @returns {Array<{ entityId: string, mediaId: string }>} Picks, one per entity (the first wins), in sent order
 */
const parse = (raw) => {
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const picks = [];
  for (const item of raw) {
    if (picks.length === MAX_PICKS) break;
    const entityId = idOf(item?.entityId);
    const mediaId = idOf(item?.mediaId);
    if (!entityId || !mediaId || seen.has(entityId)) continue;
    seen.add(entityId);
    picks.push({ entityId, mediaId });
  }
  return picks;
};

const MarkPicks = {
  parse,

  /**
   * Store a listing's picks, replacing what it held. An empty list clears them.
   *
   * @param {string} worldId - World ID
   * @param {Array<Object>} picks - From `parse`
   * @param {{ held?: boolean }} [options] - `held` stores them for the pending update's content
   */
  set: (worldId, picks, { held = false } = {}) => {
    if (picks.length === 0) {
      db.prepare('DELETE FROM world_mark_picks WHERE world_id = ? AND held = ?').run(worldId, Number(held));
      return;
    }
    db.prepare(`
      INSERT INTO world_mark_picks (world_id, held, picks) VALUES (?, ?, ?)
      ON CONFLICT (world_id, held) DO UPDATE SET picks = excluded.picks
    `).run(worldId, Number(held), JSON.stringify(picks));
  },

  /**
   * @param {string} worldId - World ID
   * @param {{ held?: boolean }} [options] - `held` reads the pending update's picks
   * @returns {Array<Object>} The stored picks, empty when none
   */
  get: (worldId, { held = false } = {}) => {
    const row = db.prepare('SELECT picks FROM world_mark_picks WHERE world_id = ? AND held = ?').get(worldId, Number(held));
    return row ? parse(JSON.parse(row.picks)) : [];
  },

  /** Make the held picks the live ones, or clear the live ones when none are held. The held row goes. */
  promote: db.transaction((worldId) => {
    MarkPicks.set(worldId, MarkPicks.get(worldId, { held: true }));
    MarkPicks.discardHeld(worldId);
  }),

  /** Drop the picks of a held update. */
  discardHeld: (worldId) => {
    db.prepare('DELETE FROM world_mark_picks WHERE world_id = ? AND held = 1').run(worldId);
  }
};

module.exports = MarkPicks;
