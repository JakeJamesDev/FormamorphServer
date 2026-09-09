const { addColumns } = require('../columns');

/**
 * The license an Avatar listing shows its readers.
 *
 * Held as a column rather than in the content file because a details view must not pay for the whole VRM
 * to render a few rows of terms, and rather than in its own table because it is one bounded object per
 * row, not a history. The catalog list projection drops it, so a page of cards never carries it.
 *
 * Only `model` rows ever fill it, and no row predates the kind, so there is no backfill.
 */
const apply = (database) => addColumns(database, 'worlds', [
  ['model_license', 'TEXT']
]).length > 0;

module.exports = { name: 'modelLicense', apply };
