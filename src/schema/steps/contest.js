const { addColumns } = require('../columns');

/**
 * The contest a listing was published into, if any.
 *
 * A flag on the listing rather than a row of its own: entry happens at publish and nowhere else, so a
 * listing belongs to at most one contest for its whole life. `ON DELETE SET NULL` because `foreign_keys`
 * is on, and a plain reference would make an event with entries impossible to delete. SQLite allows a
 * REFERENCES clause on an added column only when it defaults to NULL, which this does.
 */
const apply = (database) => addColumns(database, 'worlds', [
  ['contest_event_id', 'TEXT REFERENCES events (id) ON DELETE SET NULL']
]).length > 0;

module.exports = { name: 'contest', apply };
