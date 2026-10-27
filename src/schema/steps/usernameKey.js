const { addColumns } = require('../columns');
const { foldedUsernameSql } = require('../../config/username');

/**
 * The folded name every username lookup compares. Generated, so every write of `username` carries it and
 * no row can hold a key that disagrees with its name.
 */
const apply = (database) => addColumns(database, 'users', [
  ['username_key', `TEXT GENERATED ALWAYS AS (${foldedUsernameSql('username')}) VIRTUAL`]
]).length > 0;

module.exports = { name: 'usernameKey', apply };
