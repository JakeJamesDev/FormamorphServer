const { addColumns } = require('../columns');

/**
 * The bounce marker on an account's address, and when that address was set.
 *
 * `email_marker` is `bounce` or `complaint` while mail to the address is stopped, with `email_marked_at`
 * its time. `email_set_at` lets a late event for an old address be ignored. Existing rows get the
 * migration time: an earlier bounce is then missed rather than pinned on an address set since.
 */
const apply = (database) => {
  const added = addColumns(database, 'users', [
    ['email_marked_at', 'TEXT'],
    ['email_marker', 'TEXT'],
    ['email_set_at', 'TEXT']
  ]);

  if (added.includes('email_set_at')) {
    database.prepare('UPDATE users SET email_set_at = ? WHERE email_set_at IS NULL').run(new Date().toISOString());
  }

  return added.length > 0;
};

module.exports = { name: 'emailMarker', apply };
