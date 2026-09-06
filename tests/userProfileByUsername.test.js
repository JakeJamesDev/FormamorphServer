import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './context.js';
import { createUser, authHeader, TINY_PNG } from './helpers.js';

/**
 * The same public profile, reached by the name in a shared link.
 *
 * `formamorph.ai/u/<username>` is what a creator hands somebody, so the site holds a name where every
 * other profile route holds an id. This route resolves the one to the other and answers with the DTO
 * `/:id/profile` already builds — including the id, which is what the caller then reads creations with.
 *
 * The refusal is the interesting half: a suspended account must answer exactly the way a name nobody has
 * answers, or the 404 becomes a way to ask which accounts have been acted on.
 */

const byName = (username, viewer) => {
  const r = request(app).get(`/api/users/by-username/${encodeURIComponent(username)}/profile`);
  return viewer ? r.set(authHeader(viewer)) : r;
};

const byId = (id, viewer) => {
  const r = request(app).get(`/api/users/${id}/profile`);
  return viewer ? r.set(authHeader(viewer)) : r;
};

describe('reading a profile by the name in the link', () => {
  it('finds the account and answers with its profile', async () => {
    const user = createUser({ username: 'wren_hallow' });
    const url = (await request(app).put('/api/users/me/avatar').set(authHeader(user)).send({ image: TINY_PNG }))
      .body.data.avatarUrl;

    const res = await byName('wren_hallow');

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: user.id, username: 'wren_hallow', avatarUrl: url });
  });

  it('says exactly what the id route says', async () => {
    // One DTO, built once. A second shape here would drift from the in-app dialog's.
    const user = createUser({ username: 'osk_tinder', accountType: 'mod' });

    expect((await byName('osk_tinder')).body).toEqual((await byId(user.id)).body);
  });

  it('carries the id, so the caller can go on to ask for their creations', async () => {
    const user = createUser({ username: 'lark_venn' });

    const { id } = (await byName('lark_venn')).body.data;

    expect((await request(app).get(`/api/users/${id}/worlds`)).status).toBe(200);
  });

  it('does not mind how the link spells the capitals', async () => {
    // A name gets typed, pasted and retyped on its way into an address bar. Matching only one spelling
    // would make a working link stop working for the person who capitalized it.
    const user = createUser({ username: 'Thal_Rooke' });

    expect((await byName('thal_rooke')).body.data.id).toBe(user.id);
    expect((await byName('THAL_ROOKE')).body.data.id).toBe(user.id);
    expect((await byName('Thal_Rooke')).body.data.id).toBe(user.id);
  });

  it('gives the name as it was typed at signup, not as the link spelled it', async () => {
    createUser({ username: 'Bram_Quill' });

    expect((await byName('bram_quill')).body.data.username).toBe('Bram_Quill');
  });

  it('prefers the exact spelling when two accounts differ only by case', async () => {
    // Registration still compares names byte for byte, so both of these can exist. A folded lookup that
    // picked either one would hand two creators the same link.
    const lower = createUser({ username: 'ryen_marsh' });
    const upper = createUser({ username: 'Ryen_Marsh' });

    expect((await byName('ryen_marsh')).body.data.id).toBe(lower.id);
    expect((await byName('Ryen_Marsh')).body.data.id).toBe(upper.id);
  });

  it('reaches past a suspended namesake to the account still standing', async () => {
    // The older account holds the capitalized spelling and has been suspended. A link spelling the name
    // some third way must not land on it and refuse: nothing was done to the live creator, and their
    // link would break for every casing but the one they signed up with.
    // Dated, not just ordered: two accounts seeded in the same second tie on `created_at` and settle on
    // a random id, which would make this pass or fail by luck.
    createUser({ username: 'Gale_Wick', status: 'suspended', createdAt: '2020-01-01T00:00:00.000Z' });
    const live = createUser({ username: 'gale_wick', createdAt: '2024-01-01T00:00:00.000Z' });

    expect((await byName('GALE_WICK')).body.data.id).toBe(live.id);
    expect((await byName('gale_wick')).body.data.id).toBe(live.id);
  });

  it('still refuses the suspended account under its own exact spelling', async () => {
    // The fold reaching past it is not a way around it. Asked for byte for byte, it is the account the
    // link names, and it is not shown.
    createUser({ username: 'Rook_Ashby', status: 'suspended', createdAt: '2020-01-01T00:00:00.000Z' });
    createUser({ username: 'rook_ashby', createdAt: '2024-01-01T00:00:00.000Z' });

    expect((await byName('Rook_Ashby')).status).toBe(404);
  });

  it('hands a spelling nobody holds to the oldest of the accounts that do', async () => {
    // Some rule has to say who owns `/u/<name>` when two accounts differ only by case. Oldest wins, so
    // the answer does not move when a newer account picks up another casing.
    // Seeded newest first, so a scan that just returns rows in the order they went in gets this wrong.
    createUser({ username: 'marl_deene', createdAt: '2024-01-01T00:00:00.000Z' });
    const first = createUser({ username: 'Marl_Deene', createdAt: '2020-01-01T00:00:00.000Z' });

    expect((await byName('MARL_DEENE')).body.data.id).toBe(first.id);
  });

  it('tells a signed-in reader whether they follow them', async () => {
    const author = createUser({ username: 'ivo_sedge' });
    const reader = createUser();

    expect((await byName('ivo_sedge', reader)).body.data.following).toBe(false);

    await request(app).put(`/api/users/${author.id}/follow`).set(authHeader(reader));

    expect((await byName('ivo_sedge', reader)).body.data.following).toBe(true);
  });

  it('leaves that unanswered for a signed-out visitor', async () => {
    createUser({ username: 'nella_frost' });

    expect((await byName('nella_frost')).body.data.following).toBeUndefined();
  });
});

describe('a name the site cannot show', () => {
  it('404s a name nobody has', async () => {
    expect((await byName('nobody_at_all')).status).toBe(404);
  });

  it('answers a suspended account the way it answers a name nobody has', async () => {
    // Byte for byte, because anything else turns the 404 into a lookup for who has been acted on. A
    // creator who was suspended and a name that was never taken are one answer.
    createUser({ username: 'held_aside', status: 'suspended' });

    const suspended = await byName('held_aside');
    const unknown = await byName('never_taken');

    expect(suspended.status).toBe(unknown.status);
    expect(suspended.text).toBe(unknown.text);
  });

  it('does not show a suspended account to an ordinary signed-in reader', async () => {
    createUser({ username: 'held_aside', status: 'suspended' });
    const reader = createUser();

    expect((await byName('held_aside', reader)).status).toBe(404);
  });

  it('404s the reserved [deleted user] row', async () => {
    // It owns other people's leftover work; there is no person behind it to show.
    const res = await byName('[deleted user]');

    expect(res.status).toBe(404);
  });

  it('still shows a flagged account, which is a note for staff and not a removal', async () => {
    const user = createUser({ username: 'sable_ash', status: 'flagged' });

    expect((await byName('sable_ash')).body.data.id).toBe(user.id);
  });
});
