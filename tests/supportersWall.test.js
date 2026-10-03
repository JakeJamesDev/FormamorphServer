import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createRequire } from 'module';
import { app, db } from './context.js';
import { createUser } from './helpers.js';

const require = createRequire(import.meta.url);
const PatreonLink = require('../src/models/PatreonLink');

/** The public Supporters wall: who shows, and in what order. */

const linkAs = (user, tier, pledgeStart) => PatreonLink.link({
  userId: user.id, patreonUserId: `p-${user.id}`, tier, pledgeStart, checkedAt: new Date().toISOString()
});

const wall = async () => {
  const res = await request(app).get('/api/patreon/supporters');
  expect(res.status).toBe(200);
  return res.body.data;
};

describe('GET /api/patreon/supporters', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM patreon_links').run();
  });

  it('needs no sign-in and is empty with no supporters', async () => {
    expect(await wall()).toEqual([]);
  });

  it('lists Supporter+ first, then the earliest pledge first, null starts last in each section', async () => {
    const people = {
      plusLate: createUser({ username: 'plus-late' }),
      plusEarly: createUser({ username: 'plus-early' }),
      plusNull: createUser({ username: 'plus-null' }),
      baseEarly: createUser({ username: 'base-early' }),
      baseNull: createUser({ username: 'base-null' }),
      baseLate: createUser({ username: 'base-late' })
    };
    linkAs(people.baseLate, 'supporter', '2026-06-01T00:00:00.000+00:00');
    linkAs(people.baseNull, 'supporter', null);
    linkAs(people.plusLate, 'supporter_plus', '2026-05-01T00:00:00.000+00:00');
    linkAs(people.plusNull, 'supporter_plus', null);
    linkAs(people.baseEarly, 'supporter', '2025-01-01T00:00:00.000+00:00');
    linkAs(people.plusEarly, 'supporter_plus', '2025-02-01T00:00:00.000+00:00');

    expect((await wall()).map((row) => row.username)).toEqual([
      'plus-early', 'plus-late', 'plus-null', 'base-early', 'base-late', 'base-null'
    ]);
  });

  it('sends the account ID, username, Profile Image URL, tier, and pledge start', async () => {
    const user = createUser({ username: 'pictured' });
    db.prepare('UPDATE users SET avatar_file = ? WHERE id = ?').run('pic.webp', user.id);
    linkAs(user, 'supporter', '2026-01-01T00:00:00.000+00:00');

    expect(await wall()).toEqual([{
      id: user.id,
      username: 'pictured',
      avatarUrl: '/api/avatars/pic.webp',
      tier: 'supporter',
      since: '2026-01-01T00:00:00.000+00:00'
    }]);
  });

  it('lists a staff supporter', async () => {
    const staff = createUser({ username: 'staffer', accountType: 'admin' });
    linkAs(staff, 'supporter_plus', null);

    expect((await wall()).map((row) => row.username)).toEqual(['staffer']);
  });

  it('omits an account with the flair toggle off', async () => {
    const hidden = createUser({ username: 'hidden' });
    const shown = createUser({ username: 'shown' });
    linkAs(hidden, 'supporter_plus', null);
    linkAs(shown, 'supporter', null);
    PatreonLink.setShowFlair(hidden.id, false);

    expect((await wall()).map((row) => row.username)).toEqual(['shown']);
  });

  it('omits a suspended account, and lists it again when the suspension lifts', async () => {
    const suspended = createUser({ username: 'suspended', status: 'suspended' });
    linkAs(suspended, 'supporter_plus', null);
    expect(await wall()).toEqual([]);

    db.prepare("UPDATE users SET status = 'normal' WHERE id = ?").run(suspended.id);
    expect((await wall()).map((row) => row.username)).toEqual(['suspended']);
  });

  it('omits a lapsed member and a linked account with no tier', async () => {
    const lapsed = createUser({ username: 'lapsed' });
    linkAs(lapsed, 'supporter', '2025-01-01T00:00:00.000+00:00');
    PatreonLink.setTier({
      patreonUserId: `p-${lapsed.id}`, tier: null, pledgeStart: null, checkedAt: new Date().toISOString()
    });
    linkAs(createUser({ username: 'never-paid' }), null, null);

    expect(await wall()).toEqual([]);
  });
});
