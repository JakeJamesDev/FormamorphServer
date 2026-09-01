const { addColumns } = require('../columns');

/**
 * An organizer's color and artwork for the poster band.
 *
 * Both nullable, because both are optional: an event that sets neither renders in the app's default
 * band, which is what every event created before these existed did.
 */
const apply = (database) => addColumns(database, 'events', [
  ['poster_color', 'TEXT'],
  ['poster_image', 'TEXT']
]).length > 0;

module.exports = { name: 'poster', apply };
