const { addColumns } = require('../columns');
const { PLACEHOLDER_ID } = require('../../config/accountDeletion');
const { USERNAME_PATTERN } = require('../../config/username');

/**
 * The column that says an account must choose a new name, and the one pass that sets it.
 *
 * Flags every name outside the rule, and every account in a case-folded group except the oldest
 * (`created_at`, then `id`), so the oldest keeps the name a mention reaches. The placeholder is never
 * flagged. The pass runs only in the run that adds the column, so a later boot never flags again.
 */
const apply = (database) => {
  if (!addColumns(database, 'users', [['username_rename_required', 'INTEGER NOT NULL DEFAULT 0']]).length) {
    return false;
  }

  const rows = database.prepare('SELECT id, username FROM users ORDER BY created_at, id').all();
  const flag = database.prepare('UPDATE users SET username_rename_required = 1 WHERE id = ?');
  const seen = new Set();

  for (const { id, username } of rows) {
    // ASCII only, the same fold NOCASE applies in the uniqueness check.
    const folded = username.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
    const twin = seen.has(folded);
    seen.add(folded);

    if (id === PLACEHOLDER_ID) continue;
    if (twin || !USERNAME_PATTERN.test(username)) flag.run(id);
  }

  return true;
};

module.exports = { name: 'usernameRename', apply };
