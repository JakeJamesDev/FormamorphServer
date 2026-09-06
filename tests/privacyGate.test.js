import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app, db, migrate } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

/**
 * The Privacy Policy: a third policy row, seeded off, and the gate it becomes when an admin turns it on.
 *
 * Seeded disabled so the server can deploy ahead of the client that knows how to answer it. Once enabled,
 * every authenticated route refuses an account that has not accepted the current version — the exemptions
 * are the routes a refused user needs to get themselves out of that state.
 */

const admin = () => createUser({ username: 'root-admin', accountType: 'admin' });

/** The seeded row, put back after `setup.js` cleared it. The step only inserts when the row is absent. */
const seed = () => migrate(db);

const enablePolicy = async (adminUser, over = {}) =>
  request(app).put('/api/policies/privacy_policy').set(authHeader(adminUser)).send({
    enabled: true, title: 'Privacy Policy', body: 'What we store about you.', ...over,
  });

const accept = (user) =>
  request(app).post('/api/policies/privacy-policy/accept').set(authHeader(user));

const decline = (user) =>
  request(app).post('/api/policies/privacy-policy/decline').set(authHeader(user));

const readProfile = (user) => request(app).get('/api/users/me').set(authHeader(user));

/** An enabled policy and one account that has not answered it. */
const enabledAndUnaccepted = async () => {
  const root = admin();
  await enablePolicy(root);
  return { root, user: createUser({ username: 'reader' }) };
};

describe('the seeded row', () => {
  it('ships disabled, so deploying the server changes nothing', async () => {
    seed();
    const user = createUser({ username: 'u' });

    const policies = await request(app).get('/api/policies').set(authHeader(user));

    expect(policies.body.privacyPolicy).toBeNull();
    expect((await request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload())).status).toBe(201);
  });

  it('carries the policy text an admin can read and edit', async () => {
    seed();

    const manage = await request(app).get('/api/policies/manage').set(authHeader(admin()));

    expect(manage.body.privacyPolicy.enabled).toBe(false);
    expect(manage.body.privacyPolicy.title).toBe('Privacy Policy');
    expect(manage.body.privacyPolicy.acceptanceVersion).toBe(2);
    expect(manage.body.privacyPolicy.body).toContain('**Your email address is optional.**');
    expect(manage.body.privacyPolicy.body).toContain('**Resend** delivers verification and password-reset email.');
  });

  it('never overwrites an edited row', async () => {
    // Every boot runs the schema step again; the owner's edits have to survive that.
    const root = admin();
    seed();
    await enablePolicy(root, { body: 'The owner rewrote this.' });

    seed();

    const manage = await request(app).get('/api/policies/manage').set(authHeader(root));
    expect(manage.body.privacyPolicy.body).toBe('The owner rewrote this.');
    expect(manage.body.privacyPolicy.enabled).toBe(true);
  });

  it('takes a body longer than the other two policies accept', async () => {
    // The seeded text runs past 6000 characters, so the cap the gate and the notice share would refuse
    // the very row this server seeded.
    const root = admin();
    seed();
    const seeded = await request(app).get('/api/policies/manage').set(authHeader(root));

    const saved = await request(app).put('/api/policies/privacy_policy').set(authHeader(root))
      .send({ enabled: false, title: 'Privacy Policy', body: seeded.body.privacyPolicy.body });

    expect(seeded.body.privacyPolicy.body.length).toBeGreaterThan(4000);
    expect(saved.status).toBe(200);
  });
});

/**
 * One row per surface the ticket names: what the gate must refuse when it is on, and must leave alone when
 * it is off. The bodies are plausible but never read — the refusal happens in authentication, ahead of
 * every validator and handler.
 */
const GATED = [
  ['put', '/api/worlds/some-id/like', { like: true }, 'like a listing'],
  ['post', '/api/worlds', worldPayload(), 'publish'],
  ['post', '/api/worlds/some-id/comments', { content: 'hi' }, 'comment'],
  ['put', '/api/users/some-id/follow', undefined, 'follow an account'],
  ['post', '/api/feedback', { type: 'bug', title: 'x', category: 'other', body: 'y' }, 'file feedback'],
  ['post', '/api/reports', { targetKind: 'listing', targetId: 'some-id', category: 'other' }, 'file a report'],
  ['get', '/api/users/me', undefined, 'read its own profile'],
];

const callAs = (user, [method, path, body]) => {
  const call = request(app)[method](path).set(authHeader(user));
  return body ? call.send(body) : call;
};

describe('what the gate refuses', () => {
  for (const [method, path, body, label] of GATED) {
    it(`cannot ${label}`, async () => {
      const { user } = await enabledAndUnaccepted();

      const res = await callAs(user, [method, path, body]);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PRIVACY_REQUIRED');
      // Older clients surface `error` verbatim, so it has to tell them what to do.
      expect(res.body.error).toBe('Formamorph needs updating to continue.');
    });
  }

  it('refuses a suspended account like anyone else', async () => {
    // Suspension already refuses writes, so the gate has to be what answers the reads it leaves open.
    const root = admin();
    await enablePolicy(root);
    const user = createUser({ username: 'benched', status: 'suspended' });

    const res = await readProfile(user);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PRIVACY_REQUIRED');
  });

  it('answers a suspended write before the suspension does', async () => {
    // Both refuse it, so the order decides which dialog the client opens. The policy is the precondition
    // to using the account at all, and one answer for every request beats one for reads and another for
    // writes.
    const root = admin();
    await enablePolicy(root);
    const user = createUser({ username: 'benched', status: 'suspended' });

    const res = await request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload());

    expect(res.body.code).toBe('PRIVACY_REQUIRED');
  });
});

describe('what the gate lets through', () => {
  it('lets a new account register', async () => {
    await enablePolicy(admin());

    const res = await request(app).post('/api/auth/register')
      .send({ username: 'newcomer', password: 'password123' });

    expect(res.status).toBe(201);
  });

  it('lets an existing account log in', async () => {
    const root = admin();
    await enablePolicy(root);
    const user = createUser({ username: 'returning' });

    const res = await request(app).post('/api/auth/login')
      .send({ username: user.username, password: user.password });

    expect(res.status).toBe(200);
  });

  it('lets an account change its password', async () => {
    const { user } = await enabledAndUnaccepted();

    const res = await request(app).post('/api/auth/change-password').set(authHeader(user))
      .send({ currentPassword: user.password, newPassword: 'password456' });

    expect(res.status).toBe(200);
  });

  it('lets the policy be read, declined and accepted', async () => {
    const { user } = await enabledAndUnaccepted();

    expect((await request(app).get('/api/policies').set(authHeader(user))).status).toBe(200);
    expect((await decline(user)).status).toBe(200);
    expect((await accept(user)).status).toBe(200);
  });

  it('lets an admin still edit and reset the policy they switched on', async () => {
    // The admin has not accepted either. If the policy routes were gated, enabling it would lock the
    // owner out of the only screen that can turn it off again.
    const root = admin();
    await enablePolicy(root);

    const edit = await enablePolicy(root, { body: 'Reworded.' });
    const reset = await request(app).post('/api/policies/privacy-policy/reset')
      .set(authHeader(root)).send({});

    expect(edit.status).toBe(200);
    expect(reset.status).toBe(200);
  });

  it('leaves the public catalog alone', async () => {
    // Browsing needs no account, so a signed-in reader who has not accepted still sees what a signed-out
    // visitor sees.
    const { user } = await enabledAndUnaccepted();

    expect((await request(app).get('/api/worlds').set(authHeader(user))).status).toBe(200);
  });

  it('browses the catalog as a visitor, without the account’s own privileges', async () => {
    // An author can normally still find their quarantined listing. Unaccepted, they see the room's view.
    const root = admin();
    const author = createUser({ username: 'author' });
    const id = (await request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload())).body.data.id;
    await request(app).put(`/api/worlds/${id}/quarantine`).set(authHeader(root)).send({});
    await enablePolicy(root);

    const res = await request(app).get('/api/worlds').set(authHeader(author));

    expect(res.status).toBe(200);
    expect(res.body.data.map((w) => w.id)).not.toContain(id);
  });
});

describe('accepting', () => {
  it('opens everything the gate was closing', async () => {
    const { user } = await enabledAndUnaccepted();

    await accept(user);

    expect((await readProfile(user)).status).toBe(200);
    expect((await request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload())).status).toBe(201);
  });

  it('is reported on the policy the client reads', async () => {
    const { user } = await enabledAndUnaccepted();

    const before = await request(app).get('/api/policies').set(authHeader(user));
    await accept(user);
    const after = await request(app).get('/api/policies').set(authHeader(user));

    expect(before.body.privacyPolicy).toMatchObject({ title: 'Privacy Policy', accepted: false });
    expect(after.body.privacyPolicy.accepted).toBe(true);
  });

  it('is per user', async () => {
    const { user } = await enabledAndUnaccepted();
    const other = createUser({ username: 'someone-else' });

    await accept(user);

    expect((await readProfile(user)).status).toBe(200);
    expect((await readProfile(other)).status).toBe(403);
  });

  it('does not answer the upload gate', async () => {
    // Two policies, two answers. Accepting one must not let the other through.
    const root = admin();
    await enablePolicy(root);
    await request(app).put('/api/policies/upload_gate').set(authHeader(root))
      .send({ enabled: true, title: 'Contributor terms', body: 'Be excellent.' });
    const user = createUser({ username: 'contributor' });

    await accept(user);

    const res = await request(app).post('/api/worlds').set(authHeader(user)).send(worldPayload());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TERMS_REQUIRED');
  });
});

describe('declining', () => {
  it('refuses nothing by itself — the refusal is the gate\'s', async () => {
    const { user } = await enabledAndUnaccepted();

    await decline(user);

    const res = await readProfile(user);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PRIVACY_REQUIRED');
  });

  it('is recorded, so an admin can tell a refusal from silence', async () => {
    const { user } = await enabledAndUnaccepted();

    await decline(user);

    expect(db.prepare("SELECT response FROM policy_acceptances WHERE policy_id = 'privacy_policy'").get().response)
      .toBe('declined');
  });

  it('can be changed to an acceptance', async () => {
    const { user } = await enabledAndUnaccepted();

    await decline(user);
    await accept(user);

    expect((await readProfile(user)).status).toBe(200);
  });
});

describe('asking again', () => {
  const acceptVersionOnePolicy = async () => {
    const { root, user } = await enabledAndUnaccepted();
    // These cases begin with the policy version that production users previously accepted.
    db.prepare("UPDATE policies SET acceptance_version = 1 WHERE id = 'privacy_policy'").run();
    await accept(user);
    return { root, user };
  };

  const readAcceptanceVersions = (userId) => db.prepare(`
    SELECT a.accepted_version, p.acceptance_version
    FROM policy_acceptances a JOIN policies p ON p.id = a.policy_id
    WHERE a.policy_id = 'privacy_policy' AND a.user_id = ?
  `).get(userId);

  it('survives an ordinary edit', async () => {
    const { root, user } = await acceptVersionOnePolicy();

    await enablePolicy(root, { body: 'A typo fixed.' });

    expect((await readProfile(user)).status).toBe(200);
  });

  it('refuses the same user again after a version bump', async () => {
    const { root, user } = await acceptVersionOnePolicy();
    expect(readAcceptanceVersions(user.id)).toEqual({ accepted_version: 1, acceptance_version: 1 });

    await enablePolicy(root, { body: 'Materially different.', requireReaccept: true });

    expect(readAcceptanceVersions(user.id)).toEqual({ accepted_version: 1, acceptance_version: 2 });
    const res = await readProfile(user);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PRIVACY_REQUIRED');
  });

  it('lets them back in once they accept the new version', async () => {
    const { root, user } = await acceptVersionOnePolicy();
    await enablePolicy(root, { body: 'Materially different.', requireReaccept: true });

    await accept(user);

    expect((await readProfile(user)).status).toBe(200);
  });

  it('blocks one named user without touching anyone else', async () => {
    const { root, user } = await acceptVersionOnePolicy();
    const other = createUser({ username: 'untouched' });
    await accept(other);

    await request(app).post('/api/policies/privacy-policy/reset').set(authHeader(root))
      .send({ userId: user.id });

    expect((await readProfile(user)).status).toBe(403);
    expect((await readProfile(other)).status).toBe(200);
  });

  it('blocks everyone at once without deleting an acceptance row', async () => {
    const { root, user } = await acceptVersionOnePolicy();
    const other = createUser({ username: 'also-accepted' });
    await accept(other);
    const before = db.prepare('SELECT COUNT(*) AS c FROM policy_acceptances').get().c;

    await request(app).post('/api/policies/privacy-policy/reset').set(authHeader(root)).send({});

    expect((await readProfile(user)).status).toBe(403);
    expect((await readProfile(other)).status).toBe(403);
    expect(db.prepare('SELECT COUNT(*) AS c FROM policy_acceptances').get().c).toBe(before);
  });

  it('is written to the audit log, one entry per action however many it reached', async () => {
    const { root, user } = await acceptVersionOnePolicy();

    await request(app).post('/api/policies/privacy-policy/reset').set(authHeader(root))
      .send({ userId: user.id });
    await request(app).post('/api/policies/privacy-policy/reset').set(authHeader(root)).send({});

    // The reset put the admin back to unanswered too, and reading the log is a gated route like any other.
    await accept(root);
    const log = await request(app).get('/api/audit').set(authHeader(root));
    const actions = log.body.data.map((entry) => entry.action);

    expect(actions).toContain('privacy_reset_user');
    expect(actions).toContain('privacy_reset_all');
    // Named separately from the upload gate's, so the filter can ask which policy was reset.
    expect(actions).not.toContain('terms_reset_all');
  });

  it('rejects a reset from an ordinary account', async () => {
    const { user } = await acceptVersionOnePolicy();

    const res = await request(app).post('/api/policies/privacy-policy/reset').set(authHeader(user)).send({});

    expect(res.status).toBe(403);
    // The staff refusal, not the gate's: this user has accepted.
    expect(res.body.code).toBeUndefined();
  });
});

describe('reading it signed out', () => {
  // Registration shows the policy before the account exists, so the one screen that must render it has no
  // token to read `/api/policies` with. The text is published on the public site anyway.
  const readPublicly = () => request(app).get('/api/policies/privacy-policy');

  it('hands a signed-out visitor the approved seeded title and body', async () => {
    const root = admin();
    seed();
    const manage = await request(app).get('/api/policies/manage').set(authHeader(root));
    const approved = manage.body.privacyPolicy;
    await enablePolicy(root, { body: approved.body });

    const res = await readPublicly();

    expect(res.status).toBe(200);
    expect(res.body.privacyPolicy).toEqual({ title: 'Privacy Policy', body: approved.body });
    expect(res.body.privacyPolicy.body).toContain('Once verified, it can also receive password-reset links.');
    expect(res.body.privacyPolicy.body).toContain('When we send one, Resend receives your email address and the message.');
  });

  it('says nothing about anyone accepting it', async () => {
    // A signed-out reader is nobody, so there is no answer to report and no other policy to leak.
    await enablePolicy(admin());

    const res = await readPublicly();

    expect(res.body.privacyPolicy.accepted).toBeUndefined();
    expect(res.body.uploadGate).toBeUndefined();
  });

  it('404s while the policy is switched off', async () => {
    seed();

    expect((await readPublicly()).status).toBe(404);
  });

  it('404s when no row exists at all', async () => {
    expect((await readPublicly()).status).toBe(404);
  });
});

describe('while the policy is off', () => {
  it('refuses none of the gated routes while it is disabled', async () => {
    // The seeded state, and the whole reason this can deploy ahead of the client: every surface the gate
    // would close has to behave exactly as it did before this shipped.
    const root = admin();
    await request(app).put('/api/policies/privacy_policy').set(authHeader(root))
      .send({ enabled: false, title: 'Privacy Policy', body: 'Not live yet.' });
    const user = createUser({ username: 'u' });

    for (const route of GATED) {
      const res = await callAs(user, route);

      expect(res.body.code, `${route[0]} ${route[1]}`).not.toBe('PRIVACY_REQUIRED');
    }
    expect((await readProfile(user)).status).toBe(200);
  });

  it('refuses nothing on an enabled row with no text', async () => {
    // Only reachable by a direct database edit, but a wall with nothing written on it would be
    // unexplainable to the user who hit it.
    db.prepare(`
      INSERT INTO policies (id, enabled, title, body, tags, acceptance_version, updated_at)
      VALUES ('privacy_policy', 1, '', '', '[]', 1, '2026-01-01T00:00:00.000Z')
    `).run();

    expect((await readProfile(createUser({ username: 'u' }))).status).toBe(200);
  });

  it('404s an accept when there is nothing to accept', async () => {
    expect((await accept(createUser({ username: 'early' }))).status).toBe(404);
  });

  it('rejects a signed-out visitor', async () => {
    await enablePolicy(admin());

    expect((await request(app).post('/api/policies/privacy-policy/accept')).status).toBe(401);
  });
});
