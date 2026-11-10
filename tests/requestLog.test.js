import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { app, request, paths, scratchDir } from './context.js';

const require = createRequire(import.meta.url);
const { routineLog, createDailyLog, isRoutine } = require('../src/utils/requestLog');

/**
 * The request log's two classes: routine lines in a daily file, every other line on stdout for the journal.
 */

const today = () => new Date().toISOString().slice(0, 10);
const dayFile = () => path.join(paths.REQUEST_LOGS_DIR, `routine-${today()}.log`);

/** The day file's lines that name `url`. */
const fileLines = (url) => (fs.existsSync(dayFile()) ? fs.readFileSync(dayFile(), 'utf8').split('\n') : [])
  .filter((line) => line.includes(` ${url} `));

describe('where a request line goes', () => {
  let stdout;

  /** The stdout lines that name `url`. */
  const journalLines = (url) => stdout.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes(` ${url} `));

  beforeEach(() => {
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const get = async (url) => {
    const res = await request(app).get(url);
    await routineLog.flush();
    return res;
  };

  it.each([
    ['thumbnail', 'THUMBNAILS_DIR', '/api/thumbnails/request-log-a.png'],
    ['avatar', 'AVATARS_DIR', '/api/avatars/request-log-a.png']
  ])('writes a served %s to the day file with its time, and not to the journal', async (_noun, dirKey, url) => {
    fs.mkdirSync(paths[dirKey], { recursive: true });
    fs.writeFileSync(path.join(paths[dirKey], 'request-log-a.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

    const res = await get(url);

    expect(res.status).toBe(200);
    expect(fileLines(url)).toHaveLength(1);
    expect(fileLines(url)[0]).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z GET \/api\/\w+\/request-log-a\.png 200 /);
    expect(journalLines(url)).toHaveLength(0);
  });

  it('writes the events poll to the day file, with or without a query', async () => {
    await get('/api/events/active');
    await get('/api/events/active?request-log=b');

    expect(fileLines('/api/events/active').length).toBeGreaterThanOrEqual(1);
    expect(fileLines('/api/events/active?request-log=b')).toHaveLength(1);
    expect(journalLines('/api/events/active?request-log=b')).toHaveLength(0);
  });

  it('writes a failed thumbnail request to the journal, and not to the day file', async () => {
    const url = '/api/thumbnails/request-log-missing.png';

    const res = await get(url);

    expect(res.status).toBe(404);
    expect(journalLines(url)).toHaveLength(1);
    expect(fileLines(url)).toHaveLength(0);
  });

  it('writes a route outside the routine class to the journal', async () => {
    const url = '/api/events?request-log=c';

    const res = await get(url);

    expect(res.status).toBe(200);
    expect(journalLines(url)).toHaveLength(1);
    expect(fileLines(url)).toHaveLength(0);
  });

  it('keeps a response that never started out of the routine class', () => {
    const req = { method: 'GET', originalUrl: '/api/thumbnails/request-log-e.png' };

    expect(isRoutine(req, { headersSent: true, statusCode: 200 })).toBe(true);
    // A closed connection leaves the default status on a response that sent nothing.
    expect(isRoutine(req, { headersSent: false, statusCode: 200 })).toBe(false);
  });
});

describe('the daily log', () => {
  let dir;
  let clock;
  let log;

  const names = () => fs.readdirSync(dir).sort();
  const put = (name, text = 'old line\n') => fs.writeFileSync(path.join(dir, name), text);
  const writeOn = async (day, line) => {
    clock = new Date(`${day}T12:00:00.000Z`);
    log.write(line);
    await log.flush();
  };

  beforeEach(() => {
    dir = scratchDir('fms-request-log-');
    log = createDailyLog({ dir, keepDays: 21, now: () => clock });
  });

  it('starts a new file on each UTC day and appends within a day', async () => {
    await writeOn('2026-03-10', 'a\n');
    await writeOn('2026-03-10', 'b\n');
    await writeOn('2026-03-11', 'c\n');

    expect(fs.readFileSync(path.join(dir, 'routine-2026-03-11.log'), 'utf8')).toBe('c\n');
    expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'routine-2026-03-10.log.gz'))).toString()).toBe('a\nb\n');
    expect(names()).toEqual(['routine-2026-03-10.log.gz', 'routine-2026-03-11.log']);
  });

  it('appends to the day\'s file after a restart on the same day', async () => {
    await writeOn('2026-03-10', 'a\n');
    log = createDailyLog({ dir, keepDays: 21, now: () => clock });

    await writeOn('2026-03-10', 'b\n');

    expect(names()).toEqual(['routine-2026-03-10.log']);
    expect(fs.readFileSync(path.join(dir, 'routine-2026-03-10.log'), 'utf8')).toBe('a\nb\n');
  });

  it('removes a file older than 21 days and keeps the one that is 21 days old', async () => {
    put('routine-2026-02-16.log.gz');
    put('routine-2026-02-17.log.gz');
    put('routine-2026-02-10.log');

    await writeOn('2026-03-10', 'x\n');

    expect(names()).toEqual(['routine-2026-02-17.log.gz', 'routine-2026-03-10.log']);
  });

  it('leaves a file that is not a day file', async () => {
    put('notes.txt');
    put('routine-old.log');

    await writeOn('2026-03-10', 'x\n');

    expect(names()).toEqual(['notes.txt', 'routine-2026-03-10.log', 'routine-old.log']);
  });

  it('does not tidy again on a later write of the same day', async () => {
    await writeOn('2026-03-10', 'x\n');
    put('routine-2026-03-09.log');

    await writeOn('2026-03-10', 'y\n');

    expect(names()).toEqual(['routine-2026-03-09.log', 'routine-2026-03-10.log']);
  });

  it('reports a failed write and takes the next line', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await writeOn('2026-03-10', 'a\n');
    fs.rmSync(path.join(dir, 'routine-2026-03-10.log'));
    fs.mkdirSync(path.join(dir, 'routine-2026-03-10.log'));

    await writeOn('2026-03-10', 'lost\n');
    fs.rmdirSync(path.join(dir, 'routine-2026-03-10.log'));
    await writeOn('2026-03-10', 'b\n');

    expect(errors).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(path.join(dir, 'routine-2026-03-10.log'), 'utf8')).toBe('b\n');
    errors.mockRestore();
  });
});
