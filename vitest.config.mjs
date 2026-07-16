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
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      reporter: ['text', 'html'],
    },
  },
});
