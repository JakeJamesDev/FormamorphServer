const { PRIVACY_POLICY, PRIVACY_TITLE } = require('../../config/policies');
const { readPrivacyBody } = require('../../utils/policyBody');

/**
 * Seed the Privacy Policy, switched off.
 *
 * The row ships disabled so this server can deploy ahead of the client that knows how to answer it;
 * enabling it is the cutover, done from the admin Policies tab. Inserts only when the row is absent, so
 * every boot after the first leaves an edited policy exactly as the owner left it — including one they
 * switched on. A later change to the authored text reaches the row through `npm run publish-policy`.
 */
const apply = (database) => {
  const existing = database.prepare('SELECT id FROM policies WHERE id = ?').get(PRIVACY_POLICY);
  if (existing) return false;

  database.prepare(`
    INSERT INTO policies (id, enabled, title, body, tags, acceptance_version, updated_at)
    VALUES (?, 0, ?, ?, '[]', 2, ?)
  `).run(PRIVACY_POLICY, PRIVACY_TITLE, readPrivacyBody(), new Date().toISOString());

  return true;
};

module.exports = { name: 'privacyPolicy', apply };
