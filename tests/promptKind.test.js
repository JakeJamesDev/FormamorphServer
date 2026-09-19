import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db, Event } from './context.js';
import { createUser, authHeader, worldPayload, TINY_PNG } from './helpers.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { apply: addModelsColumn } = require('../src/schema/steps/promptModels');

/**
 * Prompt listings: a shared prompt preset, tagged with the models it works with. Prior art for the
 * route-test style is `modelKind.test.js`; the linked-content rules it shares live in
 * `linkedContent.test.js`.
 */

/** The shared preset artifact the client sends, stored as opaque JSON. */
const presetArtifact = (name = 'Slow Burn') => ({
  formamorphPreset: 1,
  appVersion: '1.40.0',
  preset: { name, prompts: { system: 'You are the narrator.' }, tuning: { temperature: 0.8 } },
});

/** A valid `POST /api/worlds` body for a prompt; override any field per test. */
const promptPayload = (overrides = {}) => ({
  kind: 'prompt',
  name: overrides.name ?? 'Slow Burn',
  description: '**Bold** notes',
  tags: ['slow burn'],
  models: ['Cydonia-24B'],
  contentData: presetArtifact(overrides.name),
  ...overrides,
});

const post = (user, body) => request(app).post('/api/worlds').set(authHeader(user)).send(body);
const put = (user, id, body) => request(app).put(`/api/worlds/${id}`).set(authHeader(user)).send(body);
const list = (query) => request(app).get(`/api/worlds${query}`);
const readOne = (id) => request(app).get(`/api/worlds/${id}`);

const names = (res) => res.body.data.map((row) => row.name).sort();

describe('publishing a prompt', () => {
  it('creates a prompt listing whose models, tags and content round-trip', async () => {
    const user = createUser();
    const res = await post(user, promptPayload({ models: ['Cydonia-24B', 'Mistral-Nemo'] }));

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      kind: 'prompt',
      name: 'Slow Burn',
      description: '**Bold** notes',
      tags: ['slow burn'],
      models: ['Cydonia-24B', 'Mistral-Nemo'],
    });
    expect(res.body.data.contentData).toEqual(presetArtifact());

    const detail = await readOne(res.body.data.id);
    expect(detail.body.data.models).toEqual(['Cydonia-24B', 'Mistral-Nemo']);

    const catalog = await list('?kind=prompt');
    expect(catalog.body.data).toHaveLength(1);
    expect(catalog.body.data[0].models).toEqual(['Cydonia-24B', 'Mistral-Nemo']);
  });

  it.each([
    ['no description field', undefined],
    ['a blank description', ''],
  ])('needs no thumbnail, and takes %s', async (_label, description) => {
    const res = await post(createUser(), promptPayload({ description }));

    expect(res.status).toBe(201);
    expect(res.body.data.description).toBe('');
    expect(res.body.data.thumbnailUrl).toMatch(/^\/api\/thumbnails\//);
  });

  it('trims models, drops blanks, and de-duplicates by case keeping the first spelling', async () => {
    const res = await post(createUser(), promptPayload({
      models: [' Cydonia-24B ', 'cydonia-24b', '', '   ', 'Mistral-Nemo'],
    }));

    expect(res.status).toBe(201);
    expect(res.body.data.models).toEqual(['Cydonia-24B', 'Mistral-Nemo']);
  });

  it.each([
    ['a number among the names', ['Cydonia', 7]],
    ['an object among the names', ['Cydonia', { id: 'x' }]],
    ['a null among the names', [null, 'Cydonia']],
    ['a string instead of a list', 'Cydonia'],
  ])('refuses models with %s, and stores nothing', async (_label, models) => {
    const res = await post(createUser(), promptPayload({ models }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/models/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM worlds WHERE kind = 'prompt'").get().n).toBe(0);
  });

  it.each([
    ['no models field', undefined],
    ['an empty list', []],
    ['only blanks', ['', '  ']],
  ])('refuses a prompt with %s: every listing says what it works with', async (_label, models) => {
    const res = await post(createUser(), promptPayload({ models }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one model/i);
  });

  it('takes content just under 1 MB and refuses content over it', async () => {
    const padded = (bytes) => ({ ...presetArtifact(), padding: 'x'.repeat(bytes) });

    expect((await post(createUser(), promptPayload({ contentData: padded(1000 * 1000) }))).status).toBe(201);

    const res = await post(createUser(), promptPayload({ contentData: padded(1024 * 1024) }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1MB/);
  });
});

describe('updating a prompt', () => {
  it('replaces the models, and keeps them when an update names none', async () => {
    const user = createUser();
    const { id } = (await post(user, promptPayload())).body.data;

    const changed = await put(user, id, { models: ['Mistral-Nemo', ' mistral-nemo '] });
    expect(changed.status).toBe(200);
    expect(changed.body.data.models).toEqual(['Mistral-Nemo']);

    const renamed = await put(user, id, { name: 'Slower Burn' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.models).toEqual(['Mistral-Nemo']);
    expect((await readOne(id)).body.data.models).toEqual(['Mistral-Nemo']);
  });

  it('counts a models change as an update to what a downloader receives', async () => {
    const user = createUser();
    const created = (await post(user, promptPayload())).body.data;

    const changed = (await put(user, created.id, { models: ['Mistral-Nemo'] })).body.data;

    expect(changed.revision).toBe(created.revision + 1);
  });

  it('refuses an update that empties the models or sends a non-string', async () => {
    const user = createUser();
    const { id } = (await post(user, promptPayload())).body.data;

    expect((await put(user, id, { models: [] })).status).toBe(400);
    expect((await put(user, id, { models: ['ok', 3] })).status).toBe(400);
    expect((await readOne(id)).body.data.models).toEqual(['Cydonia-24B']);
  });
});

describe('the model filter', () => {
  const seed = async () => {
    const user = createUser();
    await post(user, promptPayload({ name: 'Cydonia Tuned', models: ['Cydonia-24B-v4'] }));
    await post(user, promptPayload({ name: 'Nemo Tuned', models: ['Mistral-Nemo', 'Magnum'] }));
    await post(user, promptPayload({ name: 'Percent', models: ['100%-real'] }));
    // A world whose name, tags and description all say "cydonia": the filter reads models, nothing else.
    await post(user, worldPayload({ name: 'Cydonia World', description: 'cydonia', tags: ['cydonia'] }));
  };

  it('matches any model by case-insensitive substring', async () => {
    await seed();

    expect(names(await list('?kind=prompt&model=cydonia'))).toEqual(['Cydonia Tuned']);
    expect(names(await list('?kind=prompt&model=MAGNUM'))).toEqual(['Nemo Tuned']);
    expect(names(await list('?kind=prompt&model=nemo'))).toEqual(['Nemo Tuned']);
  });

  it('matches the text literally, not as a pattern', async () => {
    await seed();

    expect(names(await list('?kind=prompt&model=%25'))).toEqual(['Percent']);
    expect(names(await list('?kind=prompt&model=_'))).toEqual([]);
  });

  it('does not match across two model names or into the stored JSON', async () => {
    await seed();

    expect(names(await list(`?kind=prompt&model=${encodeURIComponent('Nemo","Magnum')}`))).toEqual([]);
    expect(names(await list(`?kind=prompt&model=${encodeURIComponent('["')}`))).toEqual([]);
  });

  it('leaves other kinds alone: a world list ignores it', async () => {
    await seed();

    expect(names(await list('?model=cydonia'))).toEqual(['Cydonia World']);
  });

  it('counts only the matches in the total', async () => {
    await seed();

    expect((await list('?kind=prompt&model=cydonia')).body.total).toBe(1);
  });
});

describe('prompts beside the other kinds', () => {
  it('appear in kind=all with every existing kind, each with a models list', async () => {
    const user = createUser();
    await post(user, worldPayload({ name: 'A World' }));
    await post(user, { name: 'A Character', kind: 'entity', contentData: { name: 'A Character' } });
    await post(user, { name: 'A Dictionary', kind: 'dictionary', contentData: { entries: [] } });
    await post(user, promptPayload({ name: 'A Prompt' }));

    const res = await list('?kind=all');

    expect(res.body.data.map((row) => [row.name, row.kind, row.models]).sort()).toEqual([
      ['A Character', 'entity', []],
      ['A Dictionary', 'dictionary', []],
      ['A Prompt', 'prompt', ['Cydonia-24B']],
      ['A World', 'world', []],
    ]);
  });

  it('never reach a client that names no kind', async () => {
    const user = createUser();
    await post(user, worldPayload({ name: 'A World' }));
    await post(user, promptPayload({ name: 'A Prompt' }));

    expect(names(await list(''))).toEqual(['A World']);
  });

  it('leave an old client that sends no models publishing and updating other kinds', async () => {
    const user = createUser();
    const created = await post(user, worldPayload({ name: 'Old Client' }));
    expect(created.status).toBe(201);
    expect(created.body.data.models).toEqual([]);

    const updated = await put(user, created.body.data.id, { name: 'Old Client 2', thumbnail: TINY_PNG });
    expect(updated.status).toBe(200);
    expect(updated.body.data.models).toEqual([]);
  });

  it('ignore models sent for another kind', async () => {
    const res = await post(createUser(), worldPayload({ models: ['Cydonia'] }));

    expect(res.status).toBe(201);
    expect(res.body.data.models).toEqual([]);
  });
});

describe('what a prompt may be linked to', () => {
  it('may declare compatible worlds, which come back on a read', async () => {
    const worldAuthor = createUser({ username: 'wren' });
    const world = (await post(worldAuthor, worldPayload({ name: 'Sedge Landing' }))).body.data;

    const res = await post(createUser(), promptPayload({ compatibleWorlds: [world.id] }));

    expect(res.status).toBe(201);
    expect(res.body.data.compatibleWorlds).toMatchObject([{ id: world.id, reviewState: 'unreviewed' }]);
    expect((await readOne(res.body.data.id)).body.data.compatibleWorlds).toMatchObject([{ id: world.id }]);
  });

  it('is offered on the world it declared, like any other add-on', async () => {
    const world = (await post(createUser(), worldPayload({ name: 'Sedge Landing' }))).body.data;
    const prompt = (await post(createUser(), promptPayload({ compatibleWorlds: [world.id] }))).body.data;

    const res = await request(app).get(`/api/worlds/${world.id}/addons`);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body.data)).toContain(prompt.id);
  });

  it('cannot be required by a world', async () => {
    const prompt = (await post(createUser(), promptPayload())).body.data;

    const res = await post(createUser(), worldPayload({ requiredDependencies: [prompt.id] }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SOURCE_NOT_COMPONENT');
  });

  it('cannot be unlisted', async () => {
    const res = await post(createUser(), promptPayload({ visibility: 'unlisted' }));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unlisted/i);
  });

  it('may be published public by name', async () => {
    const res = await post(createUser(), promptPayload({ visibility: 'public' }));

    expect(res.status).toBe(201);
    expect(res.body.data.visibility).toBe('public');
  });
});

describe('what every listing gets', () => {
  it('works for a prompt: a like, a changelog entry, and a quarantine', async () => {
    const author = createUser();
    const { id } = (await post(author, promptPayload())).body.data;

    const like = await request(app).put(`/api/worlds/${id}/like`).set(authHeader(createUser())).send({ liked: true });
    expect(like.body.data).toEqual({ liked: true, likes: 1 });

    const entry = await request(app).post(`/api/worlds/${id}/changelog`).set(authHeader(author))
      .send({ title: 'Update 1', body: 'Tighter pacing.', date: '2026-08-01' });
    expect(entry.status).toBe(201);

    const mod = createUser({ accountType: 'mod' });
    expect((await request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(mod)).send({})).status).toBe(200);
    expect((await readOne(id)).status).toBe(404);
  });
});

describe('contest entry', () => {
  it('is refused for a prompt, even while a contest is running', async () => {
    const at = (minutes) => new Date(Date.now() + minutes * 60 * 1000).toISOString();
    const event = Event.create({
      type: 'contest',
      title: 'Sedge Landing Contest',
      bannerText: 'Build on Sedge Landing.',
      body: 'Build something.',
      startsAt: at(-60),
      endsAt: at(60),
    });

    const res = await post(createUser(), promptPayload({ contestEventId: event.id }));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONTEST_KIND_REFUSED');
    expect(db.prepare("SELECT COUNT(*) AS n FROM worlds WHERE kind = 'prompt'").get().n).toBe(0);
  });
});

describe('the models column migration', () => {
  /** A worlds table as it stands on a database published before prompts existed. */
  const legacyDb = () => {
    const legacy = new Database(':memory:');
    legacy.exec("CREATE TABLE worlds (id TEXT PRIMARY KEY, name TEXT, kind TEXT NOT NULL DEFAULT 'world')");
    legacy.exec("INSERT INTO worlds (id, name) VALUES ('w-old', 'Existing World')");
    return legacy;
  };

  it('is on a freshly created worlds table', () => {
    const columns = db.prepare('PRAGMA table_info(worlds)').all().map((column) => column.name);
    expect(columns).toContain('models');
  });

  it('gives every existing row an empty list, and is a no-op the second time', () => {
    const legacy = legacyDb();

    expect(addModelsColumn(legacy)).toBe(true);
    expect(legacy.prepare("SELECT models FROM worlds WHERE id = 'w-old'").get().models).toBe('[]');
    expect(addModelsColumn(legacy)).toBe(false);
    legacy.close();
  });

  it('leaves a database with no worlds table alone', () => {
    const empty = new Database(':memory:');
    expect(addModelsColumn(empty)).toBe(false);
    empty.close();
  });
});
