import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';
import { app, request, db, migrate } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Policy = require('../src/models/Policy');
const { eraseUser } = require('../src/utils/eraseUser');
const { PASSAGE_MAX } = require('../src/utils/corefCorpus');

/**
 * Character Mentions contributions: a player's corrected passage, the staff queue that reviews it, and the
 * export of accepted ones in the training kit's annotation format.
 */

// The shared teardown deletes every policy; the schema seeds the age gate back.
beforeEach(() => {
  migrate(db);
});
afterEach(() => {
  db.prepare('DELETE FROM coref_contributions').run();
});

const tag = () => Math.random().toString(16).slice(2, 8);
const adult = (over = {}) => {
  const user = createUser({ username: `player-${tag()}`, ...over });
  Policy.accept(Policy.AGE_GATE, user.id);
  return user;
};
const mod = () => createUser({ username: `mod-${tag()}`, accountType: 'mod' });

const PASSAGE = 'Mira nodded. She drew a brass key. The courier waited by the door, and he frowned.';
const span = (text, word, from = 0) => {
  const start = text.indexOf(word, from);
  return [start, start + word.length];
};
const MIRA = span(PASSAGE, 'Mira');
const SHE = span(PASSAGE, 'She');
const COURIER = span(PASSAGE, 'The courier');
const HE = span(PASSAGE, 'he', COURIER[1] + 20);

/** The model merged "he" into Mira's cluster; the player says it is the courier. */
const payload = (over = {}) => ({
  worldId: 'world-harbor',
  passage: PASSAGE,
  modelId: 'small',
  modelVersion: 3,
  clusters: [[MIRA, SHE, HE], [COURIER]],
  clusterEntities: ['mira', 'courier'],
  corrections: [{ kind: 'mention', start: HE[0], end: HE[1], entityId: 'courier' }],
  ...over
});

const submit = (user, body = payload()) => {
  const req = request(app).post('/api/coref-contributions');
  if (user) req.set(authHeader(user));
  return req.send(body);
};
const queue = (user) => request(app).get('/api/coref-contributions').set(authHeader(user)).send();
const count = (user) => request(app).get('/api/coref-contributions/count').set(authHeader(user)).send();
const decide = (user, id, verdict) => request(app)
  .post(`/api/coref-contributions/${id}/${verdict}`).set(authHeader(user)).send();
const exportLines = async (user) => {
  const res = await request(app).get('/api/coref-contributions/export').set(authHeader(user)).send();
  expect(res.status).toBe(200);
  return res.text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
};
const exported = async (staff, id) => (await exportLines(staff)).find((line) => line.id === `contribution-${id}`);

const row = (id) => db.prepare('SELECT * FROM coref_contributions WHERE id = ?').get(id);

/** Submit as a fresh adult, then accept as staff. */
const acceptOne = async (body) => {
  const staff = mod();
  const res = await submit(adult(), body);
  expect(res.status).toBe(201);
  expect((await decide(staff, res.body.data.id, 'accept')).status).toBe(200);
  return { staff, id: res.body.data.id };
};

describe('submitting', () => {
  it('stores a pending contribution with everything the player sent', async () => {
    const user = adult();
    const res = await submit(user);

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ state: 'pending', replaced: false });
    const stored = row(res.body.data.id);
    expect(stored).toMatchObject({
      user_id: user.id,
      world_id: 'world-harbor',
      passage: PASSAGE,
      model_id: 'small',
      model_version: 3,
      state: 'pending',
      reviewed_by: null
    });
    expect(JSON.parse(stored.clusters)).toEqual([[MIRA, SHE, HE], [COURIER]]);
    expect(JSON.parse(stored.cluster_entities)).toEqual(['mira', 'courier']);
    expect(JSON.parse(stored.corrections)).toEqual(payload().corrections);
  });

  it('replaces the pending row for the same account, world and passage', async () => {
    const user = adult();
    const first = await submit(user);
    const more = payload({
      corrections: [...payload().corrections, { kind: 'mention', start: SHE[0], end: SHE[1], entityId: null }]
    });

    const second = await submit(user, more);

    expect(second.status).toBe(200);
    expect(second.body.data).toMatchObject({ id: first.body.data.id, replaced: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM coref_contributions WHERE user_id = ?').get(user.id).n).toBe(1);
    expect(JSON.parse(row(first.body.data.id).corrections)).toHaveLength(2);
  });

  it('starts a new row once the earlier one was reviewed', async () => {
    const user = adult();
    const first = await submit(user);
    await decide(mod(), first.body.data.id, 'reject');

    const second = await submit(user);

    expect(second.status).toBe(201);
    expect(second.body.data.id).not.toBe(first.body.data.id);
  });

  it('keeps one row per passage for different worlds', async () => {
    const user = adult();
    await submit(user);
    const other = await submit(user, payload({ worldId: 'world-other' }));

    expect(other.status).toBe(201);
  });
});

describe('who may submit', () => {
  it('refuses a signed-out caller', async () => {
    expect((await submit(null)).status).toBe(401);
  });

  it('refuses an account that has not confirmed its age', async () => {
    const res = await submit(createUser({ username: `minor-${tag()}` }));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AGE_GATE_REQUIRED');
  });

  it('refuses a suspended account', async () => {
    const res = await submit(adult({ status: 'suspended' }));

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/suspended/);
  });

  it('refuses an account past its hourly limit', async () => {
    const user = adult();
    for (let i = 0; i < 60; i += 1) {
      expect((await submit(user, payload({ worldId: `world-${i}` }))).status).toBe(201);
    }

    const res = await submit(user, payload({ worldId: 'world-61' }));

    expect(res.status).toBe(429);
    // Another account keeps its own budget.
    expect((await submit(adult())).status).toBe(201);
  });
});

describe('what a submit must hold', () => {
  const refused = async (over) => {
    const res = await submit(adult(), payload(over));
    expect(res.status).toBe(400);
    return res.body.error;
  };

  it('caps the passage size', async () => {
    const long = `${PASSAGE} ${'x'.repeat(PASSAGE_MAX)}`;
    expect(await refused({ passage: long })).toMatch(/cannot exceed/);
  });

  it('refuses a span outside the passage', async () => {
    expect(await refused({ clusters: [[MIRA, [80, 400]], [COURIER]] })).toMatch(/outside/);
    expect(await refused({ corrections: [{ kind: 'mention', start: 5, end: 5, entityId: null }] })).toMatch(/outside/);
  });

  it('refuses a span that splits a surrogate pair', async () => {
    const passage = '🙂 Mira waved.';
    expect(await refused({ passage, clusters: [[[1, 7]]], clusterEntities: ['mira'], corrections: [] }))
      .toMatch(/outside/);
  });

  it('refuses a span that starts or ends inside a word', async () => {
    expect(await refused({ corrections: [{ kind: 'mention', start: MIRA[0], end: MIRA[1] - 1, entityId: null }] }))
      .toMatch(/outside/);
    expect(await refused({ clusters: [[[MIRA[0] + 1, MIRA[1]], SHE], [COURIER]] })).toMatch(/outside/);
  });

  it('needs one entity per cluster', async () => {
    expect(await refused({ clusterEntities: ['mira'] })).toMatch(/entity/);
  });

  it('needs at least one correction of a known kind', async () => {
    expect(await refused({ corrections: [] })).toMatch(/correction/);
    expect(await refused({ corrections: [{ kind: 'speaker', start: HE[0], end: HE[1], entityId: null }] }))
      .toMatch(/kind/);
  });

  it('needs the model id and version and the world', async () => {
    expect(await refused({ modelId: '' })).toMatch(/model/);
    expect(await refused({ modelVersion: 0 })).toMatch(/version/);
    expect(await refused({ worldId: undefined })).toMatch(/world/);
  });
});

describe('the staff queue', () => {
  it('is closed to players', async () => {
    const player = adult();
    expect((await queue(player)).status).toBe(403);
    expect((await count(player)).status).toBe(403);
    expect((await request(app).get('/api/coref-contributions/export').set(authHeader(player))).status).toBe(403);
  });

  it('lists a pending contribution with its passage, clusters and corrections', async () => {
    const user = adult();
    const { body } = await submit(user);

    const res = await queue(mod());

    expect(res.status).toBe(200);
    const item = res.body.data.find((entry) => entry.id === body.data.id);
    expect(item).toMatchObject({
      contributorUsername: user.username,
      passage: PASSAGE,
      clusters: [[MIRA, SHE, HE], [COURIER]],
      clusterEntities: ['mira', 'courier'],
      corrections: payload().corrections,
      state: 'pending'
    });
  });

  it('counts down as staff accept and reject', async () => {
    const staff = mod();
    const a = (await submit(adult())).body.data.id;
    const b = (await submit(adult())).body.data.id;
    const before = (await count(staff)).body.pending;

    const accepted = await decide(staff, a, 'accept');
    const rejected = await decide(staff, b, 'reject');

    expect(accepted.body.data).toMatchObject({ state: 'accepted', reviewedBy: staff.id, reviewerUsername: staff.username });
    expect(rejected.body.data.state).toBe('rejected');
    expect((await count(staff)).body.pending).toBe(before - 2);
    const ids = (await queue(staff)).body.data.map((entry) => entry.id);
    expect(ids).not.toContain(a);
    expect(ids).not.toContain(b);
  });

  it('reviews a contribution once', async () => {
    const staff = mod();
    const id = (await submit(adult())).body.data.id;
    await decide(staff, id, 'reject');

    expect((await decide(staff, id, 'accept')).status).toBe(404);
    expect(row(id).state).toBe('rejected');
  });
});

describe('the export', () => {
  it('writes each accepted correction applied to its clusters, and nothing else', async () => {
    const { staff, id } = await acceptOne();
    const rejected = (await submit(adult())).body.data.id;
    await decide(staff, rejected, 'reject');
    const pending = (await submit(adult())).body.data.id;

    const lines = await exportLines(staff);

    expect(lines.find((line) => line.id === `contribution-${id}`)).toEqual({
      id: `contribution-${id}`,
      text: PASSAGE,
      clusters: [[MIRA, SHE], [COURIER, HE]]
    });
    const ids = lines.map((line) => line.id);
    expect(ids).not.toContain(`contribution-${rejected}`);
    expect(ids).not.toContain(`contribution-${pending}`);
  });

  it('leaves out a mention corrected to nobody, and drops the singletons that leaves', async () => {
    // The courier's cluster names nobody, so a "nobody" correction must not join it.
    const { staff, id } = await acceptOne(payload({
      clusterEntities: ['mira', null],
      corrections: [{ kind: 'mention', start: SHE[0], end: SHE[1], entityId: null }]
    }));

    expect((await exported(staff, id)).clusters).toEqual([[MIRA, HE]]);
  });

  it('merges every cluster named the corrected entity', async () => {
    const { staff, id } = await acceptOne(payload({
      clusters: [[MIRA, HE], [SHE], [COURIER]],
      clusterEntities: ['mira', 'mira', null],
      corrections: [{ kind: 'mention', start: COURIER[0], end: COURIER[1], entityId: 'mira' }]
    }));

    expect((await exported(staff, id)).clusters).toEqual([[MIRA, SHE, COURIER, HE]]);
  });

  it('starts a new cluster for an entity no cluster is named for', async () => {
    const { staff, id } = await acceptOne(payload({
      clusters: [[MIRA, SHE, COURIER, HE]],
      clusterEntities: ['mira'],
      corrections: [
        { kind: 'mention', start: COURIER[0], end: COURIER[1], entityId: 'courier' },
        { kind: 'mention', start: HE[0], end: HE[1], entityId: 'courier' }
      ]
    }));

    expect((await exported(staff, id)).clusters).toEqual([[MIRA, SHE], [COURIER, HE]]);
  });

  it('removes every model span the corrected span overlaps', async () => {
    // The model found "courier"; the player corrected "The courier".
    const word = span(PASSAGE, 'courier');
    const { staff, id } = await acceptOne(payload({
      clusters: [[MIRA, SHE], [word, HE]],
      clusterEntities: ['mira', 'courier'],
      corrections: [{ kind: 'mention', start: COURIER[0], end: COURIER[1], entityId: 'courier' }]
    }));

    expect((await exported(staff, id)).clusters).toEqual([[MIRA, SHE], [COURIER, HE]]);
  });

  it('skips quote-speaker corrections', async () => {
    const { staff, id } = await acceptOne(payload({
      corrections: [{ kind: 'quote', start: SHE[0], end: HE[1], entityId: 'courier' }]
    }));

    expect((await exported(staff, id)).clusters).toEqual([[MIRA, SHE, HE]]);
  });

  it('writes code-point offsets for a passage with characters outside the BMP', async () => {
    // "🙂" is two UTF-16 units and one code point, so every offset after it moves down by one.
    const passage = '🙂 Mira waved. She smiled.';
    const { staff, id } = await acceptOne({
      worldId: 'world-emoji',
      passage,
      modelId: 'big',
      modelVersion: 1,
      clusters: [[[3, 7]], [[15, 18]]],
      clusterEntities: ['mira', null],
      corrections: [{ kind: 'mention', start: 15, end: 18, entityId: 'mira' }]
    });

    expect((await exported(staff, id)).clusters).toEqual([[[2, 6], [14, 17]]]);
  });
});

describe('account deletion', () => {
  it('drops pending and rejected contributions and keeps accepted ones', async () => {
    const staff = mod();
    const user = adult();
    const pending = (await submit(user)).body.data.id;
    const accepted = (await submit(user, payload({ worldId: 'world-a' }))).body.data.id;
    const rejected = (await submit(user, payload({ worldId: 'world-b' }))).body.data.id;
    await decide(staff, accepted, 'accept');
    await decide(staff, rejected, 'reject');

    await eraseUser(user, { removeContent: true });

    expect(row(pending)).toBeUndefined();
    expect(row(accepted)).toMatchObject({ state: 'accepted', user_id: null, passage: PASSAGE });
    expect(row(rejected)).toBeUndefined();
    expect(await exported(staff, accepted)).toBeDefined();
  });
});
