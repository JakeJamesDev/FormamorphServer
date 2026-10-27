const { addColumns } = require('../columns');
const { foldedUsernameSql, isValidUsername } = require('../../config/username');

/**
 * The folded name every username lookup compares. Generated, so every write of `username` carries it and
 * no row can hold a key that disagrees with its name.
 *
 * The run that adds it also clears rename flags under the spaced rule, once. A key held by an unflagged
 * account stays with it. Otherwise the oldest flagged member (`created_at`, then `id`) whose stored name
 * passes the rule is cleared.
 */
const apply = (database) => {
  const added = addColumns(database, 'users', [
    ['username_key', `TEXT GENERATED ALWAYS AS (${foldedUsernameSql('username')}) VIRTUAL`]
  ]);
  if (added.length === 0) return false;

  const rows = database
    .prepare('SELECT id, username, username_key, username_rename_required FROM users ORDER BY created_at, id')
    .all();
  const clear = database.prepare('UPDATE users SET username_rename_required = 0 WHERE id = ?');
  const held = new Set(rows.filter((row) => !row.username_rename_required).map((row) => row.username_key));

  for (const { id, username, username_key: key, username_rename_required: flagged } of rows) {
    if (!flagged || held.has(key) || !isValidUsername(username)) continue;

    clear.run(id);
    held.add(key);
  }

  return true;
};

module.exports = { name: 'usernameKey', apply };
