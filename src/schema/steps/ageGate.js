const { AGE_GATE } = require('../../config/policies');

/** Seed the fixed adult-content warning without exposing it to policy editing. */
const apply = (database) => {
  const existing = database.prepare('SELECT id FROM policies WHERE id = ?').get(AGE_GATE);
  if (existing) return false;

  database.prepare(`
    INSERT INTO policies (id, enabled, title, body, tags, acceptance_version, updated_at)
    VALUES (?, 1, 'Adult Content Ahead', ?, '[]', 1, ?)
  `).run(
    AGE_GATE,
    [
      'Community Creations carries worlds, characters, and dictionaries written by other players. Some of what they write is adult.',
      'By choosing Accept, you confirm that you are at least 18 years old and of legal age to view adult content where you live.',
      'If you decline, nothing else changes. Your library, your worlds, and everything you have made stay yours.'
    ].join('\n\n'),
    new Date().toISOString()
  );

  return true;
};

module.exports = { name: 'ageGate', apply };
