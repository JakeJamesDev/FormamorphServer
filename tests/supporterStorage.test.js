import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { app, request, paths } from './context.js';

const require = createRequire(import.meta.url);
const storage = require('../src/utils/fileStorage');

/**
 * The private Supporter area. No public file route may reach it, by name or by walking out of the
 * directory it serves. The `.png` extension is deliberate: every public route accepts it, so a miss
 * comes from the file being unreachable, not from the extension check.
 */

const NAME = 'private-layer.png';
const BYTES = Buffer.from('not-for-everyone');

// Each public file route and the directory it serves, so the control can plant the same bytes there.
const PUBLIC_ROUTES = [
  { route: '/api/thumbnails', dir: () => paths.THUMBNAILS_DIR },
  { route: '/api/avatars', dir: () => paths.AVATARS_DIR },
  { route: '/api/event-posters', dir: () => paths.EVENT_POSTERS_DIR }
];

const privateFolder = () => path.basename(paths.SUPPORTER_PRIVATE_DIR);

beforeAll(async () => {
  storage.initStorage();
  await storage.saveSupporterFile(NAME, BYTES);
});

afterAll(async () => {
  await storage.deleteSupporterFile(NAME);
});

describe('the private area through the storage interface', () => {
  it('lives outside every directory a public route serves', () => {
    const served = PUBLIC_ROUTES.map(({ dir }) => path.resolve(dir()));
    const privateDir = path.resolve(storage.supporterStorageDir);

    for (const dir of served) {
      expect(privateDir.startsWith(dir + path.sep)).toBe(false);
      expect(dir.startsWith(privateDir + path.sep)).toBe(false);
    }
  });

  it('round-trips a file and forgets it on delete', async () => {
    await storage.saveSupporterFile('roundtrip.bin', BYTES);

    expect(storage.supporterFileExists('roundtrip.bin')).toBe(true);
    expect((await storage.readSupporterFile('roundtrip.bin')).equals(BYTES)).toBe(true);

    await storage.deleteSupporterFile('roundtrip.bin');

    expect(storage.supporterFileExists('roundtrip.bin')).toBe(false);
    expect(await storage.readSupporterFile('roundtrip.bin')).toBeNull();
  });

  it('keeps a traversing name inside the area', async () => {
    const stored = await storage.saveSupporterFile('../escaped.bin', BYTES);

    expect(stored).toBe('escaped.bin');
    expect(fs.existsSync(path.join(paths.SUPPORTER_PRIVATE_DIR, 'escaped.bin'))).toBe(true);
    expect(fs.existsSync(path.join(paths.STORAGE_ROOT, 'escaped.bin'))).toBe(false);

    await storage.deleteSupporterFile('escaped.bin');
  });
});

describe.each(PUBLIC_ROUTES)('$route', ({ route, dir }) => {
  it('serves a file in its own directory (control)', async () => {
    const planted = path.join(dir(), 'control-layer.png');
    fs.writeFileSync(planted, BYTES);

    try {
      const res = await request(app).get(`${route}/control-layer.png`);
      expect(res.status).toBe(200);
    } finally {
      fs.unlinkSync(planted);
    }
  });

  it.each([
    ['by name', NAME],
    ['by a relative walk', `../${privateFolder()}/${NAME}`],
    ['by an encoded walk', `..%2F${privateFolder()}%2F${NAME}`],
    ['by a double-encoded walk', `..%252F${privateFolder()}%252F${NAME}`],
    ['by a backslash walk', `..%5C${privateFolder()}%5C${NAME}`]
  ])('does not reach the private file %s', async (_label, requested) => {
    const res = await request(app).get(`${route}/${requested}`);

    expect(res.status).toBe(404);
  });
});
