const { addColumns } = require('../columns');

/**
 * What a reply's author was when they wrote it, so a later promotion or demotion never rewrites the
 * signature on replies somebody has already read. Not backfilled: nothing knows what anybody was when they
 * wrote an existing reply, and a null falls back to the live account type.
 */
const apply = (database) => addColumns(database, 'feedback_comments', [
  ['author_role', 'TEXT']
]).length > 0;

module.exports = { name: 'authorRole', apply };
