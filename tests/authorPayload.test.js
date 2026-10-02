import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { authorPayload } = require('../src/utils/authorPayload');

/** The one place an author object is built. */
describe('authorPayload', () => {
  it('builds the author for a normal account with no badge', () => {
    expect(authorPayload({ id: 'u1', username: 'ada', avatarFile: 'a.webp', role: 'normal' })).toEqual({
      id: 'u1',
      username: 'ada',
      avatarUrl: '/api/avatars/a.webp',
      role: null
    });
  });

  it.each(['mod', 'dev', 'admin'])('carries the %s role', (role) => {
    expect(authorPayload({ id: 'u1', username: 'ada', avatarFile: null, role }).role).toBe(role);
  });

  it('has a null avatarUrl for an account with no Profile Image', () => {
    expect(authorPayload({ id: 'u1', username: 'ada', avatarFile: null, role: null }).avatarUrl).toBeNull();
  });
});
