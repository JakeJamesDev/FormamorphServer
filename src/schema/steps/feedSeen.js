const { addColumns } = require('../columns');

/**
 * When somebody last opened their notification feed. The feed is computed from follows and listings, so
 * this one stamp is the whole unread state. Null means never opened, which is right for an existing
 * account as well as a new one, so there is nothing to backfill.
 */
const apply = (database) => addColumns(database, 'users', [
  ['feed_seen_at', 'TEXT']
]).length > 0;

module.exports = { name: 'feedSeen', apply };
