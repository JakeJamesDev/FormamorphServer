import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, fromItsOwnAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const { checkUsername, USERNAME_RULE } = require('../src/utils/usernameRule');

/**
 * The username rule at registration: 3–20 of `[A-Za-z0-9_-]`, trimmed first, unique ignoring case.
 * Seeded rows go through `createUser`, so they can hold names the rule would refuse.
 */

const register = (username) => fromItsOwnAddress(
  request(app).post('/api/auth/register').send({ username, password: 'password123' })
);

describe('registering a username', () => {
  it('accepts a name at each length boundary and every allowed character', async () => {
    for (const name of ['abc', 'a_B-9'.padEnd(20, 'x')]) {
      const res = await register(name);
      expect(res.status).toBe(201);
      expect(res.body.user.username).toBe(name);
    }
  });

  it.each([
    ['too short', 'ab'],
    ['too long', 'a'.repeat(21)],
    ['an inner space', 'ann lee'],
    ['a dot', 'ann.lee'],
    ['an at sign', 'ann@example.test'],
    ['a non-ASCII letter', 'zoë-lee'],
    ['only 2 characters once trimmed', ' ab '],
    ['the deleted-user placeholder', '[deleted user]']
  ])('refuses %s with USERNAME_INVALID and the rule text', async (_label, name) => {
    const res = await register(name);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'USERNAME_INVALID', error: USERNAME_RULE });
  });

  it('words the rule as the client shows it', () => {
    expect(USERNAME_RULE).toBe('3–20 letters, numbers, _ or -');
  });

  it('trims a leading and trailing space and stores the trimmed name', async () => {
    const res = await register('  padded-name \t');
    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('padded-name');
    expect(db.prepare('SELECT username FROM users WHERE id = ?').get(res.body.user.id).username).toBe('padded-name');
  });

  it('refuses a name that differs from an existing one only by case', async () => {
    createUser({ username: 'Wren' });
    const res = await register('wREN');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'USERNAME_TAKEN' });
  });

  it('still reports a blank name as missing, without a code', async () => {
    const res = await register('   ');
    expect(res.status).toBe(400);
    expect(res.body.code).toBeUndefined();
    expect(res.body.errors[0].msg).toBe('Username is required');
  });
});

describe('checkUsername', () => {
  it('lets the account that holds a name keep it when it is named as the exception', () => {
    const holder = createUser({ username: 'KeepMe' });
    expect(checkUsername('keepme').code).toBe('USERNAME_TAKEN');
    expect(checkUsername('keepme', { exceptUserId: holder.id })).toEqual({ ok: true, name: 'keepme' });
  });

  it('refuses a name that is not a string', () => {
    expect(checkUsername(undefined).code).toBe('USERNAME_INVALID');
    expect(checkUsername(12345).code).toBe('USERNAME_INVALID');
  });
});
