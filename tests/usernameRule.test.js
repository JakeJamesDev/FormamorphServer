import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, fromItsOwnAddress } from './helpers.js';

const require = createRequire(import.meta.url);
const { checkUsername } = require('../src/utils/usernameRule');
const { USERNAME_RULE, collapseUsername, isValidUsername } = require('../src/config/username');
const CASES = require('./fixtures/usernameRuleCases.json');

/**
 * The username rule at registration: 3–20 of `[A-Za-z0-9_-]`, trimmed first, unique ignoring case.
 * Seeded rows go through `createUser`, so they can hold names the rule would refuse.
 */

const register = (username) => fromItsOwnAddress(
  request(app).post('/api/auth/register').send({ username, password: 'password123' })
);

describe('the username rule', () => {
  it.each(CASES.map((c) => [c.name, c]))('%s', (_name, { typed, username }) => {
    const collapsed = collapseUsername(typed);
    expect(isValidUsername(collapsed) ? collapsed : null).toBe(username);
  });
});

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
    ['an inner tab', 'ann\tlee'],
    ['too long once spaces count', 'abcdefghij klmnopqrstu'],
    ['too short once collapsed', 'a  '],
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
    expect(USERNAME_RULE).toBe('3–20 letters, numbers, spaces, _ or -');
  });

  it.each([
    ['a single inner space', 'Jake James', 'Jake James'],
    ['a doubled space, stored collapsed', 'Jake  James', 'Jake James'],
    ['a space at either end, trimmed', '  Jake James ', 'Jake James'],
    ['a space next to an underscore', 'a _b', 'a _b'],
    ['a space next to a hyphen', 'a- b', 'a- b'],
    ['the shortest name with a space', 'a b', 'a b'],
    ['20 characters with spaces', 'abcdefghi klmnopqrst', 'abcdefghi klmnopqrst']
  ])('accepts %s', async (_label, typed, stored) => {
    const res = await register(typed);
    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe(stored);
    expect(db.prepare('SELECT username FROM users WHERE id = ?').get(res.body.user.id).username).toBe(stored);
  });

  it('accepts a 20-character name once a doubled space collapses', async () => {
    const res = await register('abcdefghi   klmnopqrst');
    expect(res.status).toBe(201);
    expect(res.body.user.username).toBe('abcdefghi klmnopqrst');
  });

  it('refuses the underscore form of a name that holds a space', async () => {
    createUser({ username: 'Jake James' });
    const res = await register('Jake_James');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'USERNAME_TAKEN' });
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
