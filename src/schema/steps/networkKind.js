const { addColumns } = require('../columns');

/**
 * The Network Kind beside each like, account and anonymous.
 *
 * Null when collection was off, when the address matched no list, and once the retention sweep has
 * blanked it. `config/networkKind` says what a kind is.
 */
const apply = (database) => [
  addColumns(database, 'anonymous_likes', [['network_kind', 'TEXT']]),
  addColumns(database, 'world_likes', [['network_kind', 'TEXT']])
].some((added) => added.length > 0);

module.exports = { name: 'networkKind', apply };
