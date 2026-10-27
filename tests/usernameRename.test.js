import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader, fromItsOwnAddress, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { apply: flagUsernames } = require('../src/schema/steps/usernameRename');
const { PLACEHOLDER_ID, PLACEHOLDER_USERNAME } = require('../src/config/accountDeletion');
const AuditLog = require('../src/models/AuditLog');
const User = require('../src/models/User');

/**
 * The username rule for accounts made before it: the flag step, the account payload's rename state, and
 * the rename route that clears it.
 */

/** A seeded account the flag step would have flagged. */
const flagged = (username, overrides = {}) => {
  const user = createUser({ username, ...overrides });
  db.prepare('UPDATE users SET username_rename_required = 1 WHERE id = ?').run(user.id);
  return user;
};

const stored = (id) => db.prepare('SELECT username, username_rename_required FROM users WHERE id = ?').get(id);

const login = (user) => fromItsOwnAddress(
  request(app).post('/api/auth/login').send({ username: user.username, password: user.password })
);

const me = (user) => request(app).get('/api/auth/me').set(authHeader(user));

const rename = (user, username) => fromItsOwnAddress(
  request(app).post('/api/auth/username').set(authHeader(user)).send({ username })
);

const profile = (username) =>
  request(app).get(`/api/users/by-username/${encodeURIComponent(username)}/profile`);

describe('flag step', () => {
  /** Users as they stood before the column, oldest first by `created_at`. */
  const legacyDb = () => {
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, created_at TIMESTAMP);
      INSERT INTO users (id, username, created_at) VALUES
        ('${PLACEHOLDER_ID}', '${PLACEHOLDER_USERNAME}', '2024-01-01 00:00:00'),
        ('spaced', 'ann lee', '2024-01-02 00:00:00'),
        ('dotted', 'ann.lee', '2024-01-03 00:00:00'),
        ('valid', 'wren', '2024-01-04 00:00:00'),
        ('older-twin', 'Alice', '2024-01-05 00:00:00'),
        ('newer-twin', 'alice', '2024-01-06 00:00:00'),
        ('tie-b', 'Tie', '2024-01-07 00:00:00'),
        ('tie-a', 'TIE', '2024-01-07 00:00:00');
    `);
    return legacy;
  };

  const flaggedIds = (database) => database
    .prepare('SELECT id FROM users WHERE username_rename_required = 1 ORDER BY id')
    .all()
    .map((row) => row.id);

  it('flags rule-breaking names and every case twin but the oldest', () => {
    const legacy = legacyDb();

    expect(flagUsernames(legacy)).toBe(true);
    // Same-second twins settle on the id, so `tie-a` keeps the name.
    expect(flaggedIds(legacy)).toEqual(['dotted', 'newer-twin', 'spaced', 'tie-b']);
    legacy.close();
  });

  it('changes nothing on a second run, even after a flag was cleared', () => {
    const legacy = legacyDb();
    flagUsernames(legacy);
    legacy.prepare("UPDATE users SET username_rename_required = 0 WHERE id = 'spaced'").run();

    expect(flagUsernames(legacy)).toBe(false);
    expect(flaggedIds(legacy)).toEqual(['dotted', 'newer-twin', 'tie-b']);
    legacy.close();
  });
});

describe('the account payload', () => {
  it('carries null for an unflagged account at sign-in and on /me', async () => {
    const user = createUser({ username: 'plain-account' });

    expect((await login(user)).body.user.usernameRename).toBeNull();
    expect((await me(user)).body.user.usernameRename).toBeNull();
  });

  it('carries the rename state at sign-in under the old name, and on /me', async () => {
    const user = flagged('  Brian  ');

    const signedIn = await login(user);
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.user.usernameRename).toEqual({ required: true, suggestion: 'Brian' });
    expect((await me(user)).body.user.usernameRename).toEqual({ required: true, suggestion: 'Brian' });
  });

  it.each([
    ['an inner space stays and an outside character drops', 'ann  lee!', 'ann lee'],
    ['an inner tab drops', 'ann\tlee', 'annlee'],
    ['spaces around a dropped character collapse before the cut', 'abcdefghij . klmnopqrs', 'abcdefghij klmnopqrs'],
    ['other characters drop', 'zoë.lee!', 'zolee'],
    ['the cleaned name is cut to 20', 'a long name with many words', 'a long name with man'],
    ['a cut that leaves a trailing space is trimmed', 'abcdefghijklmnopqrs tu', 'abcdefghijklmnopqrs'],
    ['a name under 3 once cleaned has none', 'é!a', null],
    ['an empty name once cleaned has none', '...', null]
  ])('suggestion: %s', async (_label, username, suggestion) => {
    const user = flagged(username);

    expect((await me(user)).body.user.usernameRename).toEqual({ required: true, suggestion });
  });

  it('suggests nothing when the cleaned name is taken ignoring case', async () => {
    createUser({ username: 'Kit_Fox' });
    const user = flagged('kit fox');

    expect((await me(user)).body.user.usernameRename.suggestion).toBeNull();
  });

  it('never counts the account itself as holding its suggestion', async () => {
    // Only a flag set by hand puts a valid, twinless name here.
    const user = flagged('Ziva');

    expect((await me(user)).body.user.usernameRename.suggestion).toBe('Ziva');
  });

  it('suggests nothing to the newer twin, whose name the oldest keeps', async () => {
    createUser({ username: 'Marlo', createdAt: '2024-01-01 00:00:00' });
    const twin = flagged('marlo', { createdAt: '2024-02-01 00:00:00' });

    expect((await me(twin)).body.user.usernameRename.suggestion).toBeNull();
  });
});

describe('the rename route', () => {
  it('writes the name, clears the flag and answers the account payload', async () => {
    const user = flagged('rena lee');

    const res = await rename(user, '  rena_lee ');

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: user.id, username: 'rena_lee', usernameRename: null });
    expect(stored(user.id)).toEqual({ username: 'rena_lee', username_rename_required: 0 });
    expect((await login({ username: 'rena_lee', password: user.password })).status).toBe(200);
  });

  it('refuses a name outside the rule with USERNAME_INVALID', async () => {
    const user = flagged('val lee');

    const res = await rename(user, 'val.lee');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'USERNAME_INVALID', error: '3–20 letters, numbers, spaces, _ or -' });
    expect(stored(user.id).username_rename_required).toBe(1);
  });

  it('accepts a spaced name, stored collapsed', async () => {
    const user = flagged('val.lee');

    const res = await rename(user, ' Val   Lee ');

    expect(res.status).toBe(200);
    expect(stored(user.id)).toEqual({ username: 'Val Lee', username_rename_required: 0 });
  });

  it('refuses the underscore form of a name that holds a space with USERNAME_TAKEN', async () => {
    createUser({ username: 'Jake James' });
    const user = flagged('jake.james');

    const res = await rename(user, 'Jake_James');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'USERNAME_TAKEN' });
  });

  it('refuses a name another account holds ignoring case with USERNAME_TAKEN', async () => {
    createUser({ username: 'Taken_Name' });
    const user = flagged('taken name');

    const res = await rename(user, 'taken_NAME');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'USERNAME_TAKEN' });
  });

  it('lets the account take its own name in other capitals', async () => {
    // `Juno` breaks no rule and has no twin, so only a flag set by hand reaches this; it proves the
    // caller's own row never counts as a holder.
    const user = flagged('Juno');

    const res = await rename(user, 'juno');

    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('juno');
  });

  it('refuses an unflagged account', async () => {
    const user = createUser({ username: 'settled-name' });

    const res = await rename(user, 'another-name');

    expect(res.status).toBe(403);
    expect(stored(user.id).username).toBe('settled-name');
  });

  it('refuses an unflagged account before it judges the name', async () => {
    const user = createUser({ username: 'settled-two' });

    const res = await rename(user, 'not valid');

    expect(res.status).toBe(403);
    expect(res.body.code).toBeUndefined();
  });

  it('refuses a second rename once the flag is cleared', async () => {
    const user = flagged('twice over');
    expect((await rename(user, 'twice_over')).status).toBe(200);

    expect((await rename(user, 'twice_again')).status).toBe(403);
  });

  it('refuses and logs nothing when the flag is cleared between the read and the write', async () => {
    const user = flagged('raced one');
    const original = User.renameFlagged;
    // Another request clears the flag just before this one's guarded write runs.
    const spy = vi.spyOn(User, 'renameFlagged').mockImplementation((id, name) => {
      db.prepare('UPDATE users SET username_rename_required = 0 WHERE id = ?').run(id);
      return original(id, name);
    });

    const res = await rename(user, 'raced_one');
    spy.mockRestore();

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'This account does not need a new username' });
    expect(stored(user.id)).toEqual({ username: 'raced one', username_rename_required: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'username_changed'").get().n).toBe(0);
  });

  it('refuses a suspended account like any other write', async () => {
    const user = flagged('sus pended', { status: 'suspended' });

    const res = await rename(user, 'sus_pended');

    expect(res.status).toBe(403);
    expect(stored(user.id).username).toBe('sus pended');
  });

  it('leaves the old name reaching no profile', async () => {
    const user = flagged('old name');
    expect((await profile('old name')).status).toBe(200);

    await rename(user, 'new_name');

    expect((await profile('old name')).status).toBe(404);
    expect((await profile('new_name')).status).toBe(200);
  });

  it('keeps the old name in earlier staff log rows and records the rename', async () => {
    const user = flagged('logged one');
    const earlier = AuditLog.record({ action: 'user_suspended', targetUser: user, targetKind: 'account', targetName: user.username });

    await rename(user, 'logged_one');

    const before = db.prepare('SELECT target_username, target_name FROM audit_log WHERE id = ?').get(earlier.id);
    expect(before).toEqual({ target_username: 'logged one', target_name: 'logged one' });
    const entry = db.prepare("SELECT * FROM audit_log WHERE action = 'username_changed' AND target_user_id = ?").get(user.id);
    expect(entry).toMatchObject({ actor_id: user.id, target_name: 'logged one', snippet: 'logged_one' });
  });
});

describe('the rename gate', () => {
  const GATE = 'username_rename_gate';
  const CODE = 'USERNAME_RENAME_REQUIRED';

  const setGate = (actor, value) =>
    request(app).put(`/api/settings/${GATE}`).set(authHeader(actor)).send({ value });
  const gateOn = async () => {
    const root = createUser({ username: 'gate-admin', accountType: 'admin' });
    expect((await setGate(root, true)).status).toBe(200);
    return root;
  };
  const publish = (user) => request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload());
  const read = (user) => request(app).get('/api/users/me').set(authHeader(user));
  const changePassword = (user) => fromItsOwnAddress(
    request(app).post('/api/auth/change-password').set(authHeader(user))
      .send({ currentPassword: user.password, newPassword: 'a-fresh-password-1' })
  );
  const askToDelete = (user) => fromItsOwnAddress(
    request(app).post('/api/auth/delete-account').set(authHeader(user)).send({ password: user.password })
  );
  const enablePrivacy = (root) => request(app).put('/api/policies/privacy_policy').set(authHeader(root))
    .send({ enabled: true, title: 'Privacy Policy', body: 'What we store about you.' });

  it('ships off: a flagged account writes as before', async () => {
    const user = flagged('off gate');

    expect((await publish(user)).status).toBe(201);
  });

  it('refuses a flagged account\'s write with the code while on, and lets its read pass', async () => {
    await gateOn();
    const user = flagged('on gate');

    const res = await publish(user);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      code: CODE,
      error: 'Update Formamorph to choose a new username.'
    });
    expect((await read(user)).status).toBe(200);
  });

  it('does not refuse an unflagged account while on', async () => {
    await gateOn();

    expect((await publish(createUser({ username: 'clear-account' }))).status).toBe(201);
  });

  it('stops refusing once the account renames', async () => {
    await gateOn();
    const user = flagged('soon renamed');
    expect((await publish(user)).status).toBe(403);

    expect((await rename(user, 'soon_renamed')).status).toBe(200);

    expect((await publish(user)).status).toBe(201);
  });

  it('answers the Privacy Policy refusal first', async () => {
    const root = await gateOn();
    expect((await enablePrivacy(root)).status).toBe(200);
    const user = flagged('both gates');

    const res = await publish(user);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PRIVACY_REQUIRED');
  });

  it('answers the suspension first, so the rename never loops on it', async () => {
    await gateOn();
    const user = flagged('sus gate', { status: 'suspended' });

    const res = await publish(user);

    expect(res.status).toBe(403);
    expect(res.body.code).toBeUndefined();
    expect(res.body.error).toMatch(/suspended/);
  });

  it('lets the rename route, password change and account deletion through', async () => {
    await gateOn();
    const user = flagged('exempt one');

    expect((await changePassword(user)).body.code).not.toBe(CODE);
    expect((await askToDelete(user)).body.code).not.toBe(CODE);
    expect((await rename(user, 'exempt_one')).status).toBe(200);
  });

  it('lets the policy routes through, which skip the policy gate', async () => {
    const root = await gateOn();
    const user = flagged('exempt two');
    expect((await enablePrivacy(root)).status).toBe(200);

    const res = await request(app).post('/api/policies/privacy-policy/accept').set(authHeader(user));

    expect(res.status).toBe(200);
  });

  it('is an admin-only setting that rejects a non-boolean', async () => {
    const root = await gateOn();

    expect((await setGate(createUser({ username: 'gate-mod', accountType: 'mod' }), false)).status).toBe(403);
    expect((await setGate(root, 'yes')).status).toBe(400);
  });
});
