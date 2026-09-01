const { addColumns } = require('../columns');

/**
 * Record what a report's author was when they filed it.
 *
 * The same fix `authorRole` made for replies, for the opening post: a thread's byline was joined live, so
 * a promotion or a demotion rewrote the badge on every report an account had ever filed. Not backfilled,
 * for the same reason; a null falls back to the live join.
 */
const apply = (database) => addColumns(database, 'feedback', [
  ['reporter_role', 'TEXT']
]).length > 0;

module.exports = { name: 'reporterRole', apply };
