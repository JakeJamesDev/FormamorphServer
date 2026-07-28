import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './context.js';
import { createUser, seedUsers, authHeader } from './helpers.js';

/**
 * `GET /api/users` backs the admin "Manage Users" table. It read none of its own query string, so the
 * search box spun and returned the whole table — and with no `total` the client could never page past one.
 */
const admin = () => createUser({ username: 'root-admin', accountType: 'admin' });

const list = (adminUser, query = '') =>
  request(app).get(`/api/users${query}`).set(authHeader(adminUser));

describe('GET /api/users access', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin', async () => {
    const res = await list(createUser({ username: 'plain' }));
    expect(res.status).toBe(403);
  });
});

describe('GET /api/users search', () => {
  it('filters by a username substring', async () => {
    const root = admin();
    createUser({ username: 'alice' });
    createUser({ username: 'bob' });
    createUser({ username: 'malice' });

    const res = await list(root, '?search=alice');

    expect(res.status).toBe(200);
    expect(res.body.data.map((u) => u.username).sort()).toEqual(['alice', 'malice']);
    expect(res.body.total).toBe(2);
  });

  it('filters by an email substring', async () => {
    const root = admin();
    createUser({ username: 'carol', email: 'carol@example.com' });
    createUser({ username: 'dave', email: 'dave@other.test' });

    const res = await list(root, '?search=example.com');

    expect(res.body.data.map((u) => u.username)).toEqual(['carol']);
  });

  it('returns nothing when the term matches nobody', async () => {
    const root = admin();
    createUser({ username: 'erin' });

    const res = await list(root, '?search=nobody-by-that-name');

    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('treats a LIKE wildcard as a literal', async () => {
    // Unescaped, `%` matches every row — a search that looks like it worked but silently ignored the term.
    const root = admin();
    createUser({ username: 'frank' });

    const res = await list(root, '?search=%25');

    expect(res.body.data).toEqual([]);
  });

  it('lists everyone when no term is given', async () => {
    const root = admin();
    createUser({ username: 'gina' });

    const res = await list(root);

    expect(res.body.data.map((u) => u.username).sort()).toEqual(['gina', 'root-admin']);
  });
});

describe('GET /api/users paging', () => {
  it('caps a page at the requested limit and reports the true total', async () => {
    const root = admin();
    for (let i = 0; i < 12; i++) createUser({ username: `paged-${i}` });

    const res = await list(root, '?page=1&limit=10');

    expect(res.body.data).toHaveLength(10);
    expect(res.body.count).toBe(10);
    expect(res.body.total).toBe(13); // 12 + the admin
    expect(res.body.pagination.next).toEqual({ page: 2, limit: 10 });
  });

  it('returns the remainder on the last page', async () => {
    const root = admin();
    for (let i = 0; i < 12; i++) createUser({ username: `paged-${i}` });

    const res = await list(root, '?page=2&limit=10');

    expect(res.body.data).toHaveLength(3);
    expect(res.body.pagination.prev).toEqual({ page: 1, limit: 10 });
    expect(res.body.pagination.next).toBeUndefined();
  });

  it('pages the filtered set, not the whole table', async () => {
    const root = admin();
    for (let i = 0; i < 5; i++) createUser({ username: `hit-${i}` });
    for (let i = 0; i < 5; i++) createUser({ username: `miss-${i}` });

    const res = await list(root, '?search=hit&limit=2');

    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(5);
  });

  it('clamps an absurd limit instead of dumping the table', async () => {
    // Needs more rows than the ceiling, or the assertion passes for the wrong reason: with only a dozen
    // users an unclamped `limit=100000` still returns a dozen.
    const root = admin();
    seedUsers(120, 'paged');

    const res = await list(root, '?limit=100000');

    expect(res.body.data).toHaveLength(100);
    expect(res.body.total).toBe(121);
  });
});

describe('GET /api/users malformed query', () => {
  // A live endpoint gets these whether or not the dialog sends them; none may 500 or leak the whole table.
  const cases = [
    ['?page=0', 'page below one'],
    ['?page=-5', 'negative page'],
    ['?page=abc', 'non-numeric page'],
    ['?limit=0', 'zero limit'],
    ['?limit=-1', 'negative limit'],
    ['?limit=abc', 'non-numeric limit'],
    ['?page=99999', 'page past the end'],
    ['?search=a&search=b', 'repeated search key'],
    ["?search=' OR 1=1 --", 'a SQL injection attempt'],
    ['?search=_', 'a bare underscore wildcard'],
  ];

  for (const [query, label] of cases) {
    it(`survives ${label}`, async () => {
      const root = admin();
      for (let i = 0; i < 3; i++) createUser({ username: `edge-${i}` });

      const res = await list(root, query);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeLessThanOrEqual(100);
    });
  }

  it('never returns more than the clamped page even at page zero', async () => {
    const root = admin();
    for (let i = 0; i < 12; i++) createUser({ username: `edge-${i}` });

    // page=0 would make offset negative; SQLite treats a negative OFFSET as 0, but the clamp is what
    // guarantees it rather than the engine's leniency.
    const res = await list(root, '?page=0&limit=10');

    expect(res.body.data).toHaveLength(10);
  });

  it('does not drop the injection attempt as a silent match-all', async () => {
    const root = admin();
    createUser({ username: 'edge-victim' });

    const res = await list(root, "?search=' OR 1=1 --");

    expect(res.body.data).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});

describe('GET /api/users paging determinism', () => {
  it('covers every user exactly once across pages when timestamps tie', async () => {
    // CURRENT_TIMESTAMP is second-resolution, so a burst of signups shares one value. Without a
    // tiebreaker, which page a tied row lands on is a query-plan detail — a user can repeat or vanish.
    const root = admin();
    for (let i = 0; i < 12; i++) createUser({ username: `tied-${String(i).padStart(2, '0')}` });

    const [first, second] = await Promise.all([
      list(root, '?page=1&limit=10'),
      list(root, '?page=2&limit=10'),
    ]);

    const seen = [...first.body.data, ...second.body.data].map((u) => u.username);

    expect(seen).toHaveLength(13);
    expect(new Set(seen).size).toBe(13); // no repeats…
    expect(seen.filter((n) => n.startsWith('tied-'))).toHaveLength(12); // …and nobody skipped
  });
});

describe('GET /api/users as the admin dialog calls it', () => {
  /** Byte-for-byte how ManageUsersDialog builds the request, so encoding is proven end to end. */
  const asDialog = (adminUser, term, page = 1) =>
    request(app)
      .get(`/api/users?${new URLSearchParams({ page: String(page), limit: '10', search: term })}`)
      .set(authHeader(adminUser));

  it('sends the whole list when the box is empty, like the dialog does on open', async () => {
    const root = admin();
    seedUsers(3, 'open');

    const res = await asDialog(root, '');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
  });

  // URLSearchParams encodes a space as `+` and a literal `+` as `%2B`; Express must decode both back.
  const terms = [
    ['ada lovelace', 'a space'],
    ['a+b', 'a literal plus'],
    ['tom&jerry', 'an ampersand'],
    ['sharp#1', 'a hash'],
    ['100%done', 'a percent'],
    ['piñata', 'a non-ASCII letter'],
    ['user_01', 'an underscore'],
  ];

  for (const [term, label] of terms) {
    it(`round-trips ${label}`, async () => {
      const root = admin();
      createUser({ username: term });
      createUser({ username: 'unrelated-person' });

      const res = await asDialog(root, term);

      expect(res.status).toBe(200);
      expect(res.body.data.map((u) => u.username)).toEqual([term]);
      expect(res.body.total).toBe(1);
    });
  }

  it('gives the dialog what it needs to compute more than one page', async () => {
    // The dialog does Math.ceil(total / 10); a missing `total` pinned it at one page forever.
    const root = admin();
    seedUsers(24, 'many');

    const res = await asDialog(root, '');

    expect(res.body.data).toHaveLength(10);
    expect(Math.ceil(res.body.total / 10)).toBe(3);
  });

  it('keeps the filter applied when the dialog pages through results', async () => {
    const root = admin();
    seedUsers(15, 'match');
    seedUsers(15, 'other');

    const [p1, p2] = await Promise.all([asDialog(root, 'match', 1), asDialog(root, 'match', 2)]);
    const names = [...p1.body.data, ...p2.body.data].map((u) => u.username);

    expect(p1.body.total).toBe(15);
    expect(names).toHaveLength(15);
    expect(new Set(names).size).toBe(15);
    expect(names.every((n) => n.startsWith('match-'))).toBe(true);
  });
});

describe('GET /api/users shape', () => {
  it('returns accountType in camelCase, like every other user response', async () => {
    // The table read `accountType`; the row carried `account_type`, so the column always showed the fallback.
    const root = admin();

    const res = await list(root, '?search=root-admin');

    expect(res.body.data[0].accountType).toBe('admin');
    expect(res.body.data[0].account_type).toBeUndefined();
  });

  it('never exposes a password hash', async () => {
    const root = admin();

    const res = await list(root);

    expect(res.body.data.every((u) => u.password === undefined)).toBe(true);
  });
});
