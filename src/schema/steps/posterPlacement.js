const { addColumns } = require('../columns');

/**
 * Where the organizer framed their artwork inside the poster band, as one nullable JSON object. One
 * column rather than three, because the three numbers are one choice. Runs after the podium step, which
 * rebuilds `events` from a fixed column list and would drop this.
 */
const apply = (database) => addColumns(database, 'events', [
  ['poster_placement', 'TEXT']
]).length > 0;

module.exports = { name: 'posterPlacement', apply };
