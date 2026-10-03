import { defineConfig } from 'vitest/config';

// `.mjs` because the package is CommonJS — a `.js` config would be parsed as CJS and reject this syntax.
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.js'],
    setupFiles: ['tests/setup.js'],
    // Each test file gets its own worker, so each gets its own in-memory database and scratch storage —
    // no shared state, no cleanup between files. Set here rather than in the tests so `config/db` sees
    // them at require time, before it opens a connection.
    env: {
      NODE_ENV: 'test',
      DB_PATH: ':memory:',
      JWT_SECRET: 'test-secret',
      // The server refuses to boot without this, so the suite supplies one the way it supplies the token
      // secret. Fixed rather than random, so a hash is the same value across a run.
      SIGNAL_SALT: 'test-salt',
      // Holds only fixture fingerprints, so no test carries bundled world text or default Avatar bytes.
      BUNDLED_FINGERPRINTS_PATH: 'tests/fixtures/test-fingerprint-list.json',
      // A configured Patreon link. No test reaches Patreon: the suite replaces the client in `utils/patreon`.
      PATREON_CLIENT_ID: 'test-client',
      PATREON_CLIENT_SECRET: 'test-client-secret',
      PATREON_REDIRECT_URI: 'https://api.example.test/api/patreon/callback',
      PATREON_CREATOR_ACCESS_TOKEN: 'test-creator-token',
      PATREON_CAMPAIGN_ID: 'test-campaign',
      PATREON_SUPPORTER_TIER_ID: 'tier-5',
      PATREON_SUPPORTER_PLUS_TIER_ID: 'tier-10',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      reporter: ['text', 'html'],
    },
  },
});
