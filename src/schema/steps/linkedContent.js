const { addColumns } = require('../columns');

/**
 * The two columns linked content adds to a listing.
 *
 * `visibility` defaults every existing row to public, which is what every row was. `revision` starts at
 * one and is bumped by every update that changes what a downloader receives, so a client can tell that a
 * source changed without the server keeping any version of it. The association tables ship through the
 * tables step, which creates a table an existing database lacks.
 */
const apply = (database) => addColumns(database, 'worlds', [
  ['visibility', "TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted'))"],
  ['revision', 'INTEGER NOT NULL DEFAULT 1']
]).length > 0;

module.exports = { name: 'linkedContent', apply };
