import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { app } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { WORLDS_DIR } = require('../src/config/paths');
const { apply: addAppVersionColumn } = require('../src/schema/steps/promptAppVersion');
const { appVersionOf } = require('../src/utils/appVersion');

/**
 * A prompt listing's `app_version`: the app version stamped on the shared preset, copied onto the row so a
 * details read shows it without reading the content.
 */

const artifact = (appVersion) => ({ kind: 'formamorph-prompt-preset', formatVersion: 1, appVersion, name: 'Slow Burn' });

const promptPayload = (overrides = {}) => ({
  kind: 'prompt',
  name: 'Slow Burn',
  description: '',
  tags: [],
  models: ['Cydonia-24B'],
  contentData: artifact('2.0.3'),
  ...overrides,
});

const post = (user, body) => request(app).post('/api/worlds').set(authHeader(user)).send(body);
const put = (user, id, body) => request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(body);
const readOne = (id) => request(app).get(`/api/worlds/${id}`);
const listed = async (id, kind) => (await request(app).get(`/api/worlds?kind=${kind}&limit=100`)).body.data
  .find((row) => row.id === id);

describe('the app version on a prompt listing', () => {
  it('is derived from the artifact on create and served by detail and list', async () => {
    const user = createUser();
    const res = await post(user, promptPayload());

    expect(res.status).toBe(201);
    expect((await readOne(res.body.data.id)).body.data.app_version).toBe('2.0.3');
    expect((await listed(res.body.data.id, 'prompt')).app_version).toBe('2.0.3');
  });

  it('follows the artifact on update', async () => {
    const user = createUser();
    const id = (await post(user, promptPayload())).body.data.id;

    expect((await put(user, id, { contentData: artifact('2.1.0') })).status).toBe(200);
    expect((await readOne(id)).body.data.app_version).toBe('2.1.0');
  });

  it('stays put when an update sends no content', async () => {
    const user = createUser();
    const id = (await post(user, promptPayload())).body.data.id;

    expect((await put(user, id, { name: 'Renamed' })).status).toBe(200);
    expect((await readOne(id)).body.data.app_version).toBe('2.0.3');
  });

  it('is null for a missing or non-string stamp', async () => {
    const user = createUser();
    const missing = await post(user, promptPayload({ contentData: { kind: 'formamorph-prompt-preset', name: 'x' } }));
    const numeric = await post(user, promptPayload({ contentData: artifact(203) }));

    expect(missing.status).toBe(201);
    expect(numeric.status).toBe(201);
    expect((await readOne(missing.body.data.id)).body.data.app_version).toBeNull();
    expect((await readOne(numeric.body.data.id)).body.data.app_version).toBeNull();
  });

  it('is null for every other kind, even when its content carries the field', async () => {
    const user = createUser();
    const res = await post(user, worldPayload({ contentData: { appVersion: '2.0.3', worldOverview: {} } }));

    expect(res.status).toBe(201);
    expect((await readOne(res.body.data.id)).body.data.app_version).toBeNull();
  });
});

describe('appVersionOf', () => {
  it('keeps a version-shaped string', () => {
    expect(appVersionOf({ appVersion: '2.0.3' })).toBe('2.0.3');
    expect(appVersionOf({ appVersion: '2.1.0-beta.2' })).toBe('2.1.0-beta.2');
  });

  it('drops anything that is not a short version string', () => {
    expect(appVersionOf({ appVersion: '<script>' })).toBeNull();
    expect(appVersionOf({ appVersion: '' })).toBeNull();
    expect(appVersionOf({ appVersion: `1.${'0'.repeat(64)}` })).toBeNull();
    expect(appVersionOf({ appVersion: ['2.0.3'] })).toBeNull();
    expect(appVersionOf(null)).toBeNull();
    expect(appVersionOf('2.0.3')).toBeNull();
  });
});

describe('the app version column migration', () => {
  const legacyDb = () => {
    const legacy = new Database(':memory:');
    legacy.exec("CREATE TABLE worlds (id TEXT PRIMARY KEY, name TEXT, kind TEXT NOT NULL DEFAULT 'world', content_file TEXT)");
    return legacy;
  };

  it('backfills prompt rows from their stored content, and is a no-op the second time', () => {
    const file = `migration-${Date.now()}.json`;
    fs.writeFileSync(path.join(WORLDS_DIR, file), JSON.stringify(artifact('2.0.1')));
    const legacy = legacyDb();
    legacy.prepare("INSERT INTO worlds (id, name, kind, content_file) VALUES ('p', 'Prompt', 'prompt', ?)").run(file);
    legacy.prepare("INSERT INTO worlds (id, name, kind, content_file) VALUES ('w', 'World', 'world', ?)").run(file);
    legacy.prepare("INSERT INTO worlds (id, name, kind, content_file) VALUES ('gone', 'Lost', 'prompt', 'missing.json')").run();

    expect(addAppVersionColumn(legacy)).toBe(true);
    const version = (id) => legacy.prepare('SELECT app_version FROM worlds WHERE id = ?').get(id).app_version;
    expect(version('p')).toBe('2.0.1');
    expect(version('w')).toBeNull();
    expect(version('gone')).toBeNull();

    expect(addAppVersionColumn(legacy)).toBe(false);
    legacy.close();
    fs.unlinkSync(path.join(WORLDS_DIR, file));
  });

  it('leaves a database with no worlds table alone', () => {
    const empty = new Database(':memory:');
    expect(addAppVersionColumn(empty)).toBe(false);
    empty.close();
  });
});
