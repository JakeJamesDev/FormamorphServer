import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader, worldPayload } from './helpers.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const PatreonLink = require('../src/models/PatreonLink');
const { tierFor, tierStateOf } = require('../src/config/patreon');
const { qualifiesForSupporterContent } = require('../src/utils/supporterAccess');
const { apply: allowTopTier } = require('../src/schema/steps/supporterTop');
const { setPatreonClient, resetPatreonClient } = require('../src/utils/patreon');
const { reconcilePatreon } = require('../src/utils/reconcilePatreon');

/**
 * The third Supporter tier key, `supporter_top`: its Patreon tier mapping, the Supporter content qualifier,
 * the Supporters wall order, and the rebuild that widens the stored CHECK. The mapping is tested at its
 * seam, `tierStateOf`, and again through the webhook and the reconcile, which both call it.
 */

const linkAs = (user, tier, pledgeStart = null) => PatreonLink.link({
  userId: user.id, patreonUserId: `p-${user.id}`, tier, pledgeStart, checkedAt: new Date().toISOString()
});

describe('mapping the Patreon tier ID', () => {
  it('maps the top tier ID to supporter_top', () => {
    expect(tierFor(['tier-top'])).toBe('supporter_top');
  });

  it('reads a member who holds several tiers as the highest', () => {
    expect(tierFor(['tier-5', 'tier-10', 'tier-top'])).toBe('supporter_top');
    expect(tierFor(['tier-5', 'tier-10'])).toBe('supporter_plus');
  });

  it('gives a pledge start with the top tier, and none without a tier', () => {
    expect(tierStateOf({ tierIds: ['tier-top'], pledgeStart: '2026-01-01T00:00:00.000+00:00' }))
      .toEqual({ tier: 'supporter_top', pledgeStart: '2026-01-01T00:00:00.000+00:00' });
    expect(tierStateOf({ tierIds: ['tier-other'], pledgeStart: 'x' })).toEqual({ tier: null, pledgeStart: null });
  });
});

describe('the top tier through the webhook and the reconcile', () => {
  afterEach(() => resetPatreonClient());

  const memberBody = (patreonUserId, tierIds) => JSON.stringify({
    data: {
      attributes: { patron_status: 'active_patron', pledge_relationship_start: '2026-03-01T00:00:00.000+00:00' },
      id: `member-${patreonUserId}`,
      relationships: {
        campaign: { data: { id: 'test-campaign', type: 'campaign' } },
        currently_entitled_tiers: { data: tierIds.map((id) => ({ id, type: 'tier' })) },
        user: { data: { id: patreonUserId, type: 'user' } }
      },
      type: 'member'
    },
    included: []
  });

  it('moves a linked account to supporter_top on a webhook delivery', async () => {
    const user = createUser();
    linkAs(user, 'supporter');
    const body = memberBody(`p-${user.id}`, ['tier-top']);
    const signature = crypto.createHmac('md5', 'test-webhook-secret').update(body).digest('hex');
    setPatreonClient({
      identify: async () => { throw new Error('not used'); },
      members: async () => [{
        patreonUserId: `p-${user.id}`, tierIds: ['tier-top'], pledgeStart: '2026-03-01T00:00:00.000+00:00'
      }]
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    try {
      const res = await request(app).post('/api/patreon/webhook')
        .set('Content-Type', 'application/json')
        .set('X-Patreon-Event', 'members:pledge:update')
        .set('X-Patreon-Signature', signature)
        .send(body);
      await vi.runAllTimersAsync();

      expect(res.status).toBe(200);
      expect(PatreonLink.findByUser(user.id).tier).toBe('supporter_top');
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves a linked account to supporter_top on a reconcile', async () => {
    const user = createUser();
    linkAs(user, 'supporter');
    setPatreonClient({
      identify: async () => { throw new Error('not used'); },
      members: async () => [{
        patreonUserId: `p-${user.id}`, tierIds: ['tier-5', 'tier-top'], pledgeStart: '2026-03-01T00:00:00.000+00:00'
      }]
    });

    await reconcilePatreon();

    expect(PatreonLink.findByUser(user.id).tier).toBe('supporter_top');
  });
});

describe('Supporter content for the top tier', () => {
  it('qualifies a top-tier account, and not an account with no tier', () => {
    const top = createUser();
    linkAs(top, 'supporter_top');

    expect(qualifiesForSupporterContent(top.id)).toBe(true);
    expect(qualifiesForSupporterContent(createUser().id)).toBe(false);
  });

  it('serves the gated route to a top-tier account', async () => {
    const author = createUser();
    const created = await request(app).post('/api/worlds').set(authHeader(author)).send(worldPayload());
    const id = created.body.data.id;
    const staff = createUser({ accountType: 'admin' });
    await request(app).put(`/api/worlds/${id}/supporter-only`).set(authHeader(staff)).send({ supporterOnly: true });
    const top = createUser();
    linkAs(top, 'supporter_top');

    const res = await request(app).get(`/api/worlds/${id}/supporter-content`).set(authHeader(top));

    expect(res.status).toBe(200);
  });
});

describe('the Supporters wall', () => {
  beforeEach(() => {
    db.prepare('DELETE FROM patreon_links').run();
  });

  it('lists the top tier above Supporter+ and Supporter, earliest pledge first inside a tier', async () => {
    const people = {
      baseEarly: createUser({ username: 'base-early' }),
      plusEarly: createUser({ username: 'plus-early' }),
      topLate: createUser({ username: 'top-late' }),
      topEarly: createUser({ username: 'top-early' }),
      topNull: createUser({ username: 'top-null' })
    };
    linkAs(people.baseEarly, 'supporter', '2024-01-01T00:00:00.000+00:00');
    linkAs(people.plusEarly, 'supporter_plus', '2024-02-01T00:00:00.000+00:00');
    linkAs(people.topLate, 'supporter_top', '2026-05-01T00:00:00.000+00:00');
    linkAs(people.topNull, 'supporter_top', null);
    linkAs(people.topEarly, 'supporter_top', '2025-02-01T00:00:00.000+00:00');

    const res = await request(app).get('/api/patreon/supporters');

    expect(res.body.data.map((row) => row.username))
      .toEqual(['top-early', 'top-late', 'top-null', 'plus-early', 'base-early']);
    expect(res.body.data[0].tier).toBe('supporter_top');
  });
});

describe('the tier column', () => {
  it('stores supporter_top on a fresh database, and still refuses an unknown key', () => {
    const user = createUser();

    expect(() => linkAs(user, 'supporter_top')).not.toThrow();
    expect(() => linkAs(createUser(), 'supporter_giga')).toThrow(/CHECK/);
  });
});

/** The links table as every database has it before this step. */
const OLD_LINKS_SQL = `
  CREATE TABLE patreon_links (
    user_id TEXT PRIMARY KEY,
    patreon_user_id TEXT NOT NULL UNIQUE,
    tier TEXT CHECK (tier IN ('supporter', 'supporter_plus')),
    pledge_start TEXT,
    show_flair INTEGER NOT NULL DEFAULT 1,
    checked_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  )
`;

const oldDb = () => {
  const old = new Database(':memory:');
  old.pragma('foreign_keys = ON');
  old.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
  old.exec(OLD_LINKS_SQL);
  old.exec("INSERT INTO users (id) VALUES ('u-1'), ('u-2'), ('u-3')");
  old.exec(`
    INSERT INTO patreon_links (user_id, patreon_user_id, tier, pledge_start, show_flair, checked_at, created_at)
    VALUES ('u-1', 'p-1', 'supporter', '2025-01-01', 1, '2026-01-01', '2025-01-02'),
           ('u-2', 'p-2', 'supporter_plus', NULL, 0, NULL, '2025-02-02'),
           ('u-3', 'p-3', NULL, NULL, 1, '2026-01-01', '2025-03-02')
  `);
  return old;
};

const rowsIn = (connection) => connection.prepare('SELECT * FROM patreon_links ORDER BY user_id').all();

describe('migrating a two-tier database', () => {
  it('keeps every link, with its tier, pledge start, flair toggle and dates', () => {
    const old = oldDb();
    const before = rowsIn(old);

    expect(allowTopTier(old)).toBe(true);
    expect(rowsIn(old)).toEqual(before);

    old.close();
  });

  it('takes the top tier once it has run, which the old CHECK refused', () => {
    const old = oldDb();
    const insertTop = () => old.prepare(`
      INSERT INTO patreon_links (user_id, patreon_user_id, tier, created_at)
      VALUES ('u-1', 'p-new', 'supporter_top', 'x')
    `).run();
    old.exec('DELETE FROM patreon_links');

    expect(insertTop).toThrow(/CHECK/);
    allowTopTier(old);
    expect(insertTop).not.toThrow();

    old.close();
  });

  it('keeps the unique Patreon user and the account cascade', () => {
    const old = oldDb();
    allowTopTier(old);

    expect(() => old.prepare(`
      INSERT INTO patreon_links (user_id, patreon_user_id, tier, created_at)
      VALUES ('u-9', 'p-1', NULL, 'x')
    `).run()).toThrow(/UNIQUE|FOREIGN KEY/);

    old.prepare("DELETE FROM users WHERE id = 'u-1'").run();
    expect(rowsIn(old).map((row) => row.user_id)).toEqual(['u-2', 'u-3']);

    old.close();
  });

  it('is a no-op the second time, and leaves a database with no links table alone', () => {
    const old = oldDb();
    allowTopTier(old);

    expect(allowTopTier(old)).toBe(false);
    expect(rowsIn(old)).toHaveLength(3);
    old.close();

    const empty = new Database(':memory:');
    expect(allowTopTier(empty)).toBe(false);
    empty.close();
  });
});
