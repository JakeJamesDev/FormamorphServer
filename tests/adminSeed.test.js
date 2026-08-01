import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { db, createTables } from './context.js';

const require = createRequire(import.meta.url);
const { createAdminUser } = require('../src/utils/initDb');

/**
 * The one account that can delete every listing and suspend every user.
 *
 * It used to be seeded with `admin123` whenever `ADMIN_PASSWORD` was unset, and the setup docs
 * prescribed exactly that value — so a by-the-book install shipped with a guessable owner and no
 * sign anything was wrong. These prove the seeder now refuses instead of guessing.
 */

const ADMIN_VARS = ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_EMAIL'];

let saved;

beforeEach(() => {
  createTables();
  saved = Object.fromEntries(ADMIN_VARS.map((key) => [key, process.env[key]]));
  for (const key of ADMIN_VARS) delete process.env[key];
  db.prepare("DELETE FROM users WHERE account_type = 'admin'").run();
});

afterEach(() => {
  for (const key of ADMIN_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  db.prepare("DELETE FROM users WHERE account_type = 'admin'").run();
});

const admins = () => db.prepare("SELECT * FROM users WHERE account_type = 'admin'").all();

describe('seeding the first administrator', () => {
  it('refuses when no password is configured, and creates nothing', async () => {
    process.env.ADMIN_USERNAME = 'owner';

    await expect(createAdminUser()).rejects.toThrow(/ADMIN_PASSWORD is not set/);
    expect(admins()).toHaveLength(0);
  });

  it('refuses the password the old docs prescribed', async () => {
    process.env.ADMIN_USERNAME = 'owner';
    process.env.ADMIN_PASSWORD = 'admin123';

    await expect(createAdminUser()).rejects.toThrow(/well-known setup default/);
    expect(admins()).toHaveLength(0);
  });

  it('refuses a short password', async () => {
    process.env.ADMIN_USERNAME = 'owner';
    process.env.ADMIN_PASSWORD = 'shortpass11';

    await expect(createAdminUser()).rejects.toThrow(/at least 12 characters/);
    expect(admins()).toHaveLength(0);
  });

  it('seeds one admin when the password is a real one', async () => {
    process.env.ADMIN_USERNAME = 'owner';
    process.env.ADMIN_PASSWORD = 'a-generated-passphrase-nobody-guesses';
    process.env.ADMIN_EMAIL = 'owner@example.com';

    await createAdminUser();

    const rows = admins();
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe('owner');
    // Stored hashed, never as given.
    expect(rows[0].password).not.toBe(process.env.ADMIN_PASSWORD);
  });

  it('tolerates a missing password when the admin already exists', async () => {
    process.env.ADMIN_USERNAME = 'owner';
    process.env.ADMIN_PASSWORD = 'a-generated-passphrase-nobody-guesses';
    await createAdminUser();

    // A deploy that reruns the seed routinely must not start failing over an env var nothing reads:
    // once the administrator exists, the password rules guard nothing.
    delete process.env.ADMIN_PASSWORD;

    await expect(createAdminUser()).resolves.toBeUndefined();
    expect(admins()).toHaveLength(1);
  });

  it('leaves an existing admin alone rather than reseeding over it', async () => {
    process.env.ADMIN_USERNAME = 'owner';
    process.env.ADMIN_PASSWORD = 'a-generated-passphrase-nobody-guesses';

    await createAdminUser();
    const first = admins()[0];

    process.env.ADMIN_PASSWORD = 'a-different-passphrase-entirely';
    await createAdminUser();

    const rows = admins();
    expect(rows).toHaveLength(1);
    expect(rows[0].password).toBe(first.password);
  });

  it('is not wired into the boot path, so serving never invents an owner', () => {
    const boot = require('fs').readFileSync(require.resolve('../src/server.js'), 'utf8');

    expect(boot).not.toContain('createAdminUser');
  });
});

describe('the setup docs', () => {
  it('no longer prescribe the forbidden password', () => {
    const readme = require('fs').readFileSync(require.resolve('../README.md'), 'utf8');

    expect(readme).not.toContain('admin123');
  });
});
