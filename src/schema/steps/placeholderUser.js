const { PLACEHOLDER_ID, PLACEHOLDER_USERNAME, SYSTEM_STATUS, NO_PASSWORD } = require('../../config/accountDeletion');

/**
 * Seed the account that owns the work of everyone who left but kept it.
 *
 * A real row rather than a null author, because `worlds.author_id` and `comments.author_id` are NOT NULL
 * and every reader joins them — a null would mean touching every one of those queries to keep a listing
 * readable. Reassigning to this row instead leaves each of them exactly as it is.
 *
 * Inserted only when absent, on the rule every seeding step follows, so a boot never overwrites it. Its
 * status is one login refuses before it compares a password, and the password column holds a value no
 * hash comparison can match.
 */
const apply = (database) => {
  const existing = database.prepare('SELECT id FROM users WHERE id = ?').get(PLACEHOLDER_ID);
  if (existing) return false;

  const stamp = new Date().toISOString();

  database.prepare(`
    INSERT INTO users (id, username, password, email, status, account_type, created_at, updated_at)
    VALUES (?, ?, ?, NULL, ?, 'normal', ?, ?)
  `).run(PLACEHOLDER_ID, PLACEHOLDER_USERNAME, NO_PASSWORD, SYSTEM_STATUS, stamp, stamp);

  return true;
};

module.exports = { name: 'placeholderUser', apply };
