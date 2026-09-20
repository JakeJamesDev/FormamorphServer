import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { app, db, migrate } from './context.js';
import { createUser } from './helpers.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const Policy = require('../src/models/Policy');
const { publishPrivacyPolicy, diffLines } = require('../src/utils/publishPolicy');
const { readPrivacyBody } = require('../src/utils/policyBody');

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * `npm run publish-policy` — the only road from the authored markdown to the live row.
 *
 * Boot seeds the row once and then leaves it alone, so a deploy that changes the markdown changes nothing a
 * reader sees. These prove the publish step moves the body and only the body, asks for acceptance again only
 * when told to, and shows what it is about to replace before it replaces it.
 */

/** The row as a live server holds it: switched on, renamed, and at an older wording. */
const seedLiveRow = (body = 'Old wording.\n\nShared line.') =>
  Policy.save(Policy.PRIVACY_POLICY, { enabled: true, title: 'Our Privacy Policy', body, tags: [] });

const stored = () => db.prepare("SELECT * FROM policies WHERE id = 'privacy_policy'").get();

describe('a dry run', () => {
  it('reports the diff and leaves the row alone', () => {
    const before = seedLiveRow();

    const result = publishPrivacyPolicy({ body: 'New wording.\n\nShared line.' });

    expect(result.status).toBe('pending');
    expect(result.diff).toEqual(['-Old wording.', '+New wording.']);
    expect(stored().body).toBe('Old wording.\n\nShared line.');
    expect(stored().updated_at).toBe(before.updated_at);
  });
});

describe('a write', () => {
  it('serves the authored file on the public route, and keeps the title and the switch', async () => {
    seedLiveRow();

    const result = publishPrivacyPolicy({ write: true });

    expect(result.status).toBe('published');
    const res = await request(app).get('/api/policies/privacy-policy');
    expect(res.body.privacyPolicy.body).toBe(readPrivacyBody());
    expect(res.body.privacyPolicy.title).toBe('Our Privacy Policy');
    expect(stored().enabled).toBe(1);
  });

  it('keeps every acceptance when re-accept is not asked for', () => {
    const before = seedLiveRow();
    const reader = createUser();
    Policy.accept(Policy.PRIVACY_POLICY, reader.id);

    const result = publishPrivacyPolicy({ write: true, body: 'New wording.' });

    expect(result.version).toBe(before.acceptance_version);
    expect(Policy.hasAccepted(Policy.PRIVACY_POLICY, reader.id)).toBe(true);
  });

  it('asks everyone again when re-accept is asked for', () => {
    const before = seedLiveRow();
    const reader = createUser();
    Policy.accept(Policy.PRIVACY_POLICY, reader.id);

    const result = publishPrivacyPolicy({ write: true, requireReaccept: true, body: 'New wording.' });

    expect(result.version).toBe(before.acceptance_version + 1);
    expect(Policy.hasAccepted(Policy.PRIVACY_POLICY, reader.id)).toBe(false);
  });

  it('never bumps the version for a body already published, so a repeated run asks nobody twice', () => {
    const before = seedLiveRow('Same wording.');

    const result = publishPrivacyPolicy({ write: true, requireReaccept: true, body: 'Same wording.' });

    expect(result.status).toBe('unchanged');
    expect(stored().acceptance_version).toBe(before.acceptance_version);
    expect(stored().updated_at).toBe(before.updated_at);
  });
});

describe('refusals', () => {
  it('refuses when no row exists, rather than creating one switched off', () => {
    expect(() => publishPrivacyPolicy({ write: true, body: 'New wording.' })).toThrow(/absent/);
    expect(stored()).toBeUndefined();
  });

  it('refuses a body the admin route would refuse, and writes nothing', () => {
    seedLiveRow();

    expect(() => publishPrivacyPolicy({ write: true, body: 'x'.repeat(20001) })).toThrow(/20001/);
    expect(stored().body).toBe('Old wording.\n\nShared line.');
  });
});

describe('the diff', () => {
  it('lists only changed lines, in reading order', () => {
    const before = ['Title', 'kept', 'removed from the middle', 'kept too', 'old tail'].join('\n');
    const after = ['Title', 'kept', 'kept too', 'added', 'new tail'].join('\n');

    expect(diffLines(before, after)).toEqual([
      '-removed from the middle',
      '-old tail',
      '+added',
      '+new tail'
    ]);
  });
});

describe('the authored file', () => {
  it('reads the same body from a CRLF checkout as from an LF one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fms-policy-'));
    const file = path.join(dir, 'policy.md');
    fs.writeFileSync(file, 'First line.\r\n\r\nSecond line.\r\n');

    expect(readPrivacyBody(file)).toBe('First line.\n\nSecond line.');
  });
});

describe('the command', () => {
  /** A database file with the live row in it, for a child process to open. */
  const liveDatabase = (body) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fms-publish-')), 'live.db');
    const fresh = new Database(file);
    migrate(fresh);
    fresh.prepare("UPDATE policies SET enabled = 1, body = ? WHERE id = 'privacy_policy'").run(body);
    fresh.close();
    return file;
  };

  const run = (file, ...flags) => spawnSync(
    process.execPath,
    ['src/utils/runPublishPolicy.js', ...flags],
    { cwd: ROOT, env: { ...process.env, DB_PATH: file }, encoding: 'utf8' }
  );

  const read = (file) => {
    const live = new Database(file, { readonly: true });
    const row = live.prepare("SELECT * FROM policies WHERE id = 'privacy_policy'").get();
    live.close();
    return row;
  };

  it('writes nothing without --write', () => {
    const file = liveDatabase('Old wording.');

    const result = run(file);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('-Old wording.');
    expect(result.stdout).toContain('pending acceptance_version=2');
    expect(read(file).body).toBe('Old wording.');
  });

  it('publishes and bumps with --write --reaccept', () => {
    const file = liveDatabase('Old wording.');

    const result = run(file, '--write', '--reaccept');

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('published acceptance_version=3');
    expect(read(file).body).toBe(readPrivacyBody());
    expect(read(file).enabled).toBe(1);
  });

  it('fails when a re-accept was asked for and did not happen', () => {
    const file = liveDatabase(readPrivacyBody());

    const result = run(file, '--write', '--reaccept');

    expect(result.status).toBe(1);
    expect(read(file).acceptance_version).toBe(2);
  });

  it('refuses a flag it does not know, so a typo cannot pass as a dry run', () => {
    const file = liveDatabase('Old wording.');

    const result = run(file, '--wirte');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--wirte');
    expect(read(file).body).toBe('Old wording.');
  });
});
