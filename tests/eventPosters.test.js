import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { app, db, paths, Event } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { addPosterColumns } = require('../src/utils/addPosterColumns');
const { addPosterPlacement } = require('../src/utils/addPosterPlacement');

/**
 * How an organizer's poster styling is stored, served and cleaned up.
 *
 * Two optional fields with one rule between them: an event that sets neither is exactly the event that
 * existed before they did, which is what lets a client run ahead of this server and a server run ahead
 * of its clients. The artwork is a file rather than a column, so the rest of this is about the file's
 * life — written on the write that named it, replaced by its replacement, and gone with the event.
 */

const at = (offsetMinutes) => new Date(Date.now() + offsetMinutes * 60 * 1000).toISOString();

const payload = (over = {}) => ({
  type: 'announcement',
  title: 'Sedge Landing Week',
  bannerText: 'A week of building on Sedge Landing.',
  body: 'Build something on Sedge Landing before the week is out.',
  startsAt: at(60),
  endsAt: at(120),
  ...over
});

const admin = () => createUser({ username: `admin-${Math.random().toString(16).slice(2, 8)}`, accountType: 'admin' });

/** A one-pixel PNG, as the admin form sends artwork: a data URI in the event's own body. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** An image past the 2MB cap but inside the route's body limit, so the cap is what refuses it. */
const oversized = () => `data:image/png;base64,${Buffer.alloc(Math.round(2.2 * 1024 * 1024)).toString('base64')}`;

const create = (user, body = {}) => request(app).post('/api/events').set(authHeader(user)).send(payload(body));

const posterPath = (url) => path.join(paths.EVENT_POSTERS_DIR, path.basename(url));

const posterExists = (url) => fs.existsSync(posterPath(url));

/** An events table as it stands on a database published before poster styling existed. */
const legacyDb = () => {
  const legacy = new Database(':memory:');
  legacy.exec('CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT)');
  return legacy;
};

describe('the poster styling columns', () => {
  it('are on a freshly created events table', () => {
    const columns = db.prepare('PRAGMA table_info(events)').all().map((column) => column.name);

    expect(columns).toContain('poster_color');
    expect(columns).toContain('poster_image');
  });

  it('are added to an events table that predates them', () => {
    const legacy = legacyDb();

    expect(addPosterColumns(legacy)).toBe(true);
    const columns = legacy.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
    expect(columns).toEqual(expect.arrayContaining(['poster_color', 'poster_image']));

    legacy.close();
  });

  it('are a no-op the second time, so every boot after the first costs nothing', () => {
    const legacy = legacyDb();

    addPosterColumns(legacy);
    expect(addPosterColumns(legacy)).toBe(false);

    legacy.close();
  });

  it('leave a database with no events table alone', () => {
    const empty = new Database(':memory:');

    expect(addPosterColumns(empty)).toBe(false);

    empty.close();
  });
});

describe('scheduling a styled event', () => {
  it('stores the color and answers with it', async () => {
    const response = await create(admin(), { posterColor: '#1E3A8A' });

    expect(response.status).toBe(201);
    expect(response.body.data.posterColor).toBe('#1e3a8a');
  });

  it('stores the artwork as a file and answers with its URL', async () => {
    const response = await create(admin(), { posterImage: PNG });

    expect(response.status).toBe(201);
    expect(response.body.data.posterImageUrl).toMatch(/^\/api\/event-posters\/[0-9a-f-]+\.png$/);
    expect(posterExists(response.body.data.posterImageUrl)).toBe(true);
  });

  it('answers with nulls for an event nobody styled', async () => {
    const response = await create(admin());

    expect(response.body.data.posterColor).toBeNull();
    expect(response.body.data.posterImageUrl).toBeNull();
  });

  it('takes a shorthand hex and stores what it expands to, so every reader sees one form', async () => {
    const response = await create(admin(), { posterColor: '#0AF' });

    expect(response.status).toBe(201);
    expect(response.body.data.posterColor).toBe('#00aaff');
  });

  it('refuses a color CSS could not paint, rather than storing it to be ignored', async () => {
    for (const color of ['rebeccapurple', '#12', '#abcd', '#12345', '#gggggg', 'rgb(1, 2, 3)']) {
      const response = await create(admin(), { posterColor: color });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/hex color/);
    }
  });

  it('refuses a subtype that only names something every object inherits', async () => {
    // The allowlist is looked up by the subtype the caller sent, so `constructor` would otherwise find
    // `Object` on the prototype, read as an allowed type, and be written under its stringified form.
    const response = await create(admin(), { posterImage: 'data:image/constructor;base64,AAAA' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Unsupported poster type/);
  });

  it('refuses artwork past the cap', async () => {
    const response = await create(admin(), { posterImage: oversized() });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/2MB/);
  });

  it('refuses a body too large to be any poster, before it is ever decoded', async () => {
    // The route's own limit, standing in front of the cap: an upload this size is never read into memory.
    const response = await create(admin(), {
      posterImage: `data:image/png;base64,${Buffer.alloc(5 * 1024 * 1024).toString('base64')}`
    });

    expect(response.status).toBe(413);
  });

  it('refuses a file type it does not serve', async () => {
    const response = await create(admin(), { posterImage: 'data:image/svg+xml;base64,PHN2Zy8+' });

    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/Unsupported poster type/);
  });

  it('writes no file for an event it is about to refuse', async () => {
    const author = admin();
    const before = fs.readdirSync(paths.EVENT_POSTERS_DIR).length;

    // The window runs backwards: refused before anything is stored.
    const response = await create(author, { posterImage: PNG, startsAt: at(120), endsAt: at(60) });

    expect(response.status).toBe(400);
    expect(fs.readdirSync(paths.EVENT_POSTERS_DIR)).toHaveLength(before);
  });
});

describe('editing a styled event', () => {
  const styled = async () => {
    const author = admin();
    const response = await create(author, { posterColor: '#1e3a8a', posterImage: PNG });
    return { author, event: response.body.data };
  };

  it('leaves the artwork alone on an edit that never mentions it', async () => {
    const { author, event } = await styled();

    const response = await request(app)
      .put(`/api/events/${event.id}`)
      .set(authHeader(author))
      .send({ title: 'Renamed' });

    expect(response.body.data.posterImageUrl).toBe(event.posterImageUrl);
    expect(posterExists(event.posterImageUrl)).toBe(true);
  });

  it('clears the artwork, and the file with it, when it is explicitly removed', async () => {
    const { author, event } = await styled();

    const response = await request(app)
      .put(`/api/events/${event.id}`)
      .set(authHeader(author))
      .send({ posterImage: null });

    expect(response.body.data.posterImageUrl).toBeNull();
    expect(posterExists(event.posterImageUrl)).toBe(false);
  });

  it('replaces the artwork and removes what it replaced', async () => {
    const { author, event } = await styled();

    const response = await request(app)
      .put(`/api/events/${event.id}`)
      .set(authHeader(author))
      .send({ posterImage: PNG });

    expect(response.body.data.posterImageUrl).not.toBe(event.posterImageUrl);
    expect(posterExists(response.body.data.posterImageUrl)).toBe(true);
    expect(posterExists(event.posterImageUrl)).toBe(false);
  });

  it('puts the band back to the default when the color is cleared', async () => {
    const { author, event } = await styled();

    const response = await request(app)
      .put(`/api/events/${event.id}`)
      .set(authHeader(author))
      .send({ posterColor: '' });

    expect(response.body.data.posterColor).toBeNull();
  });

  it('leaves the color alone on an edit that never mentions it', async () => {
    const { author, event } = await styled();

    const response = await request(app)
      .put(`/api/events/${event.id}`)
      .set(authHeader(author))
      .send({ title: 'Renamed' });

    expect(response.body.data.posterColor).toBe('#1e3a8a');
  });
});

describe('removing a styled event', () => {
  it('takes its artwork with it, so nothing is left orphaned on disk', async () => {
    const author = admin();
    const { body } = await create(author, { posterImage: PNG });

    await request(app).delete(`/api/events/${body.data.id}`).set(authHeader(author)).expect(200);

    expect(posterExists(body.data.posterImageUrl)).toBe(false);
  });

  it('keeps the artwork of an event that was merely called off, which still exists', async () => {
    const author = admin();
    const { body } = await create(author, { posterImage: PNG, startsAt: at(-60), endsAt: at(60) });

    await request(app).post(`/api/events/${body.data.id}/cancel`).set(authHeader(author)).expect(200);

    expect(posterExists(body.data.posterImageUrl)).toBe(true);
  });
});

describe('serving the artwork', () => {
  it('hands it to anyone, signed in or not — the poster is public', async () => {
    const { body } = await create(admin(), { posterImage: PNG });

    const response = await request(app).get(body.data.posterImageUrl);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  it('caches it forever, since the filename is the version', async () => {
    const { body } = await create(admin(), { posterImage: PNG });

    const response = await request(app).get(body.data.posterImageUrl);

    expect(response.headers['cache-control']).toContain('immutable');
  });

  it('misses on a name nothing is ever stored under', async () => {
    await request(app).get('/api/event-posters/anything.svg').expect(404);
  });

  it('cannot be walked out of its own directory', async () => {
    await request(app).get('/api/event-posters/..%2f..%2fpackage.json').expect(404);
  });
});

describe('an event carrying no styling', () => {
  it('reads the same as it did before the columns existed', async () => {
    // The compatibility promise in both directions: a row written by the old code has nulls here, and
    // the DTO says so rather than omitting the fields.
    const event = Event.create({
      type: 'announcement',
      title: 'Older Notice',
      bannerText: 'From before the columns.',
      body: 'Still readable.',
      startsAt: at(-60),
      endsAt: at(60)
    });

    const response = await request(app).get('/api/events/active');
    const served = response.body.data.find((row) => row.id === event.id);

    expect(served).toMatchObject({ posterColor: null, posterImageUrl: null });
  });
});

/**
 * Where the artwork is framed inside the band.
 *
 * One nullable column holding one choice: absent means the centered cover, which is what every event
 * rendered as before there was a choice to make. The column is written through an API, so what is
 * really being tested is that nothing outside `{ zoom 1-4, x/y 0-1 }` can be stored to be rendered.
 */

const PLACEMENT = { zoom: 2, x: 0.25, y: 0.75 };

/** An events table as it stands on a database published before poster placement existed. */
const prePlacementDb = () => {
  const legacy = new Database(':memory:');
  legacy.exec('CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT, poster_image TEXT)');
  return legacy;
};

const edit = (user, id, body) => request(app).put(`/api/events/${id}`).set(authHeader(user)).send(body);

describe('the poster placement column', () => {
  it('is on a freshly created events table', () => {
    const columns = db.prepare('PRAGMA table_info(events)').all().map((column) => column.name);

    expect(columns).toContain('poster_placement');
  });

  it('is added to an events table that predates it', () => {
    const legacy = prePlacementDb();

    expect(addPosterPlacement(legacy)).toBe(true);
    expect(legacy.prepare('PRAGMA table_info(events)').all().map((c) => c.name))
      .toContain('poster_placement');

    legacy.close();
  });

  it('is a no-op the second time, so every boot after the first costs nothing', () => {
    const legacy = prePlacementDb();

    addPosterPlacement(legacy);
    expect(addPosterPlacement(legacy)).toBe(false);

    legacy.close();
  });

  it('leaves a database with no events table alone', () => {
    const empty = new Database(':memory:');

    expect(addPosterPlacement(empty)).toBe(false);

    empty.close();
  });

  it('is added after the podium migration, which rebuilds the table from a fixed column list', () => {
    // Run the other way round, the rebuild drops the column that was just added and the framing of
    // every event on that database goes with it.
    const boot = fs.readFileSync(require.resolve('../src/server.js'), 'utf8');

    expect(boot.indexOf('addEventPlacements()')).toBeLessThan(boot.indexOf('addPosterPlacement()'));
    expect(boot.indexOf('addPosterPlacement()')).toBeLessThan(boot.indexOf('createIndexes()'));
  });
});

describe('scheduling a framed event', () => {
  it('stores the framing and answers with it', async () => {
    const response = await create(admin(), { posterImage: PNG, posterPlacement: PLACEMENT });

    expect(response.status).toBe(201);
    expect(response.body.data.posterPlacement).toEqual(PLACEMENT);
  });

  it('answers with none for an event nobody framed', async () => {
    const response = await create(admin(), { posterImage: PNG });

    expect(response.body.data.posterPlacement).toBeNull();
  });

  it('takes both ends of each range, which are choices an organizer can really make', async () => {
    for (const placement of [{ zoom: 1, x: 0, y: 0 }, { zoom: 4, x: 1, y: 1 }]) {
      const response = await create(admin(), { posterImage: PNG, posterPlacement: placement });

      expect(response.status).toBe(201);
      expect(response.body.data.posterPlacement).toEqual(placement);
    }
  });

  it('refuses anything no organizer’s controls could have produced', async () => {
    for (const placement of [
      { zoom: 2, x: 0.5 },
      { zoom: 0.5, x: 0.5, y: 0.5 },
      { zoom: 4.1, x: 0.5, y: 0.5 },
      { zoom: 2, x: -0.01, y: 0.5 },
      { zoom: 2, x: 0.5, y: 1.01 },
      { zoom: 2, x: '0.5', y: 0.5 },
      { zoom: 'lots', x: 0.5, y: 0.5 },
      [2, 0.5, 0.5],
      'centered'
    ]) {
      const response = await create(admin(), { posterImage: PNG, posterPlacement: placement });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Poster placement/);
    }
  });

  it('refuses a zoom that is a number in name only', async () => {
    // JSON has no NaN, but a body sent as text can still carry one past the parser as a raw token.
    const response = await request(app)
      .post('/api/events')
      .set(authHeader(admin()))
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...payload({ posterImage: PNG }), posterPlacement: { zoom: 1e999, x: 0.5, y: 0.5 } }));

    expect(response.status).toBe(400);
  });

  it('keeps no framing for artwork that was never uploaded', async () => {
    // Nothing to frame, and a transform left in the row would misplace whatever is uploaded next.
    const response = await create(admin(), { posterPlacement: PLACEMENT });

    expect(response.status).toBe(201);
    expect(response.body.data.posterPlacement).toBeNull();
  });
});

describe('editing a framed event', () => {
  const framed = async () => {
    const author = admin();
    const response = await create(author, { posterImage: PNG, posterPlacement: PLACEMENT });
    return { author, event: response.body.data };
  };

  it('takes a nudged framing without the artwork being sent again', async () => {
    const { author, event } = await framed();
    const moved = { zoom: 3, x: 0.4, y: 0.6 };

    const response = await edit(author, event.id, { posterPlacement: moved });

    expect(response.status).toBe(200);
    expect(response.body.data.posterPlacement).toEqual(moved);
    // The file it frames is untouched, which is the whole point of storing rather than baking.
    expect(response.body.data.posterImageUrl).toBe(event.posterImageUrl);
    expect(posterExists(event.posterImageUrl)).toBe(true);
  });

  it('leaves the framing alone on an edit that never mentions it', async () => {
    const { author, event } = await framed();

    const response = await edit(author, event.id, { title: 'Renamed' });

    expect(response.body.data.posterPlacement).toEqual(PLACEMENT);
  });

  it('restores the centered cover when the framing is explicitly cleared', async () => {
    const { author, event } = await framed();

    const response = await edit(author, event.id, { posterPlacement: null });

    expect(response.body.data.posterPlacement).toBeNull();
    expect(response.body.data.posterImageUrl).toBe(event.posterImageUrl);
  });

  it('refuses a framing outside its ranges, leaving the stored one where it was', async () => {
    const { author, event } = await framed();

    const response = await edit(author, event.id, { posterPlacement: { zoom: 9, x: 0.5, y: 0.5 } });

    expect(response.status).toBe(400);
    const stored = await request(app).get(`/api/events/${event.id}`).set(authHeader(author));
    expect(stored.body.data.posterPlacement).toEqual(PLACEMENT);
  });

  it('clears the framing along with the artwork it framed', async () => {
    const { author, event } = await framed();

    const response = await edit(author, event.id, { posterImage: null });

    expect(response.body.data.posterImageUrl).toBeNull();
    expect(response.body.data.posterPlacement).toBeNull();
  });

  it('recenters when different artwork arrives without a framing of its own', async () => {
    // A transform chosen for one picture crops a different one somewhere nobody meant.
    const { author, event } = await framed();

    const response = await edit(author, event.id, { posterImage: PNG });

    expect(response.body.data.posterImageUrl).not.toBe(event.posterImageUrl);
    expect(response.body.data.posterPlacement).toBeNull();
  });

  it('takes new artwork and its framing together', async () => {
    const { author, event } = await framed();
    const moved = { zoom: 1.5, x: 0.2, y: 0.8 };

    const response = await edit(author, event.id, { posterImage: PNG, posterPlacement: moved });

    expect(response.body.data.posterPlacement).toEqual(moved);
  });
});

describe('reading a framed event back', () => {
  it('serves the framing on the lists, slim rows included', async () => {
    const author = admin();
    const scheduled = await create(author, { posterImage: PNG, posterPlacement: PLACEMENT });

    const slim = await request(app).get('/api/events?slim').set(authHeader(author));
    const row = slim.body.data.find((event) => event.id === scheduled.body.data.id);

    expect(row.posterPlacement).toEqual(PLACEMENT);
    // Still a slim row: the prose is what those leave out.
    expect(row).not.toHaveProperty('body');
  });

  it('reads a column somebody wrote by hand as no framing at all', async () => {
    // The rendering client would otherwise position artwork off the edge of its own band.
    const author = admin();
    const scheduled = await create(author, { posterImage: PNG });
    db.prepare('UPDATE events SET poster_placement = @junk WHERE id = @id')
      .run({ id: scheduled.body.data.id, junk: '{"zoom":99,"x":"left"}' });

    const response = await request(app).get(`/api/events/${scheduled.body.data.id}`).set(authHeader(author));

    expect(response.body.data.posterPlacement).toBeNull();
  });

  it('reads a column that is not even JSON as no framing at all', async () => {
    const author = admin();
    const scheduled = await create(author, { posterImage: PNG });
    db.prepare('UPDATE events SET poster_placement = @junk WHERE id = @id')
      .run({ id: scheduled.body.data.id, junk: 'centered' });

    const response = await request(app).get(`/api/events/${scheduled.body.data.id}`).set(authHeader(author));

    expect(response.body.data.posterPlacement).toBeNull();
  });
});
