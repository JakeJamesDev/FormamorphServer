const fs = require('fs');
const path = require('path');
const { PRIVACY_POLICY, PRIVACY_TITLE } = require('../../config/policies');

/** The authored text, read from disk so the owner and a lawyer edit markdown rather than a string literal. */
const BODY_FILE = path.join(__dirname, '..', '..', 'assets', 'policies', 'privacy-policy.md');

/**
 * Seed the Privacy Policy, switched off.
 *
 * The row ships disabled so this server can deploy ahead of the client that knows how to answer it;
 * enabling it is the cutover, done from the admin Policies tab. Inserts only when the row is absent, so
 * every boot after the first leaves an edited policy exactly as the owner left it — including one they
 * switched on.
 *
 * Line endings are normalized because the repo checks out CRLF on Windows, and the seeded body should not
 * depend on which machine ran the migration.
 */
const apply = (database) => {
  const existing = database.prepare('SELECT id FROM policies WHERE id = ?').get(PRIVACY_POLICY);
  if (existing) return false;

  const body = fs.readFileSync(BODY_FILE, 'utf8').replace(/\r\n/g, '\n').trim();

  database.prepare(`
    INSERT INTO policies (id, enabled, title, body, tags, acceptance_version, updated_at)
    VALUES (?, 0, ?, ?, '[]', 2, ?)
  `).run(PRIVACY_POLICY, PRIVACY_TITLE, body, new Date().toISOString());

  return true;
};

module.exports = { name: 'privacyPolicy', apply };
