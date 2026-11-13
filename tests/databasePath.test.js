import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { migrate, scratchDir } from './context.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

/**
 * Where the database comes from. A shell without `.env` once opened the default path and made an empty
 * database there; now every entry point reads the repo's `.env` from any directory, and only `init-db` may
 * create a database.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Run a script as an operator would. `DB_PATH` is unset unless given, and no local `.env` is read. */
const run = (script, { env = {}, args = [], cwd } = {}) => {
  const dir = cwd || scratchDir('fms-dbpath-');
  const childEnv = { ...process.env, ENV_FILE: path.join(dir, 'missing.env'), ...env };
  if (!env.DB_PATH) delete childEnv.DB_PATH;
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...args], {
    cwd: dir, env: childEnv, encoding: 'utf8', timeout: 15000
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}`, dir };
};

const migratedDatabase = (dir) => {
  const file = path.join(dir, 'live.db');
  const live = new Database(file);
  migrate(live);
  live.close();
  return file;
};

describe('a database path with no file behind it', () => {
  it('stops an operator script and creates nothing', () => {
    const dir = scratchDir('fms-dbpath-');
    const file = path.join(dir, 'data', 'typo.db');

    const { code, output } = run('src/utils/mergeUsers.js', { env: { DB_PATH: file }, args: ['a', 'b'], cwd: dir });

    expect(code).toBe(1);
    expect(output).toContain(`No database at ${file}`);
    expect(fs.existsSync(path.join(dir, 'data'))).toBe(false);
  });

  it('stops the server before it serves an empty site', () => {
    const dir = scratchDir('fms-dbpath-');
    const file = path.join(dir, 'typo.db');

    const { code, output } = run('src/server.js', {
      env: { DB_PATH: file, STORAGE_ROOT: path.join(dir, 'storage'), PORT: '0' }, cwd: dir
    });

    expect(code).not.toBe(0);
    expect(output).toContain(`No database at ${file}`);
    expect(output).not.toContain('Server running');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('stops a backup before it writes one without the database', () => {
    const dir = scratchDir('fms-dbpath-');
    const backups = path.join(dir, 'backups');

    const { code, output } = run('src/utils/runBackup.js', {
      env: { DB_PATH: path.join(dir, 'typo.db'), BACKUPS_DIR: backups, STORAGE_ROOT: path.join(dir, 'storage') },
      cwd: dir
    });

    expect(code).toBe(1);
    expect(output).toContain('refusing a backup without it');
    expect(fs.existsSync(backups)).toBe(false);
  });

  it('is created by init-db, the one command allowed to', () => {
    const dir = scratchDir('fms-dbpath-');
    const file = path.join(dir, 'data', 'fresh.db');

    const { code, output } = run('src/utils/initDb.js', {
      env: {
        DB_PATH: file,
        STORAGE_ROOT: path.join(dir, 'storage'),
        ADMIN_USERNAME: 'owner',
        ADMIN_PASSWORD: 'a-real-password-for-tests'
      },
      cwd: dir
    });

    expect(code, output).toBe(0);
    const created = new Database(file, { readonly: true });
    expect(created.prepare("SELECT account_type FROM users WHERE username = 'owner'").get().account_type).toBe('admin');
    created.close();
  });
});

describe('the env file', () => {
  it('is the repo’s own, whatever directory the shell is in', () => {
    const childEnv = { ...process.env };
    delete childEnv.ENV_FILE;
    const result = spawnSync(process.execPath, ['-p', `require(${JSON.stringify(path.join(ROOT, 'src/config/loadEnv'))}).envFile`], {
      cwd: scratchDir('fms-dbpath-cwd-'), env: childEnv, encoding: 'utf8'
    });

    expect(result.stdout.trim()).toBe(path.join(ROOT, '.env'));
  });

  it('reaches a script run from another directory', () => {
    const dir = scratchDir('fms-dbpath-');
    const file = migratedDatabase(dir);
    const envFile = path.join(dir, 'operator.env');
    fs.writeFileSync(envFile, `DB_PATH=${file}\n`);
    const elsewhere = scratchDir('fms-dbpath-cwd-');

    const { code, output } = run('src/utils/mergeUsers.js', {
      env: { ENV_FILE: envFile }, args: ['nobody', 'someone'], cwd: elsewhere
    });

    // Refused for the missing account, which means it opened the database the file named.
    expect(code).toBe(1);
    expect(output).toContain("User 'nobody' not found");
  });
});
