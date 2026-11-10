import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { app, request, db, paths, scratchDir } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const { setMailTransport, resetMailTransport, captureTransport } = require('../src/utils/mail');
const Setting = require('../src/models/Setting');
const { checkStorage, setProbe, resetProbe } = require('../src/utils/storageCheck');
const { DIRECTORY_PARTS } = require('../src/config/storage');

/**
 * The disk-full alerts the hourly storage check sends.
 *
 * The disk reading is injected: a test cannot fill a real disk. The mails are read where the admins see them,
 * in the urgent messages and the staff mailbox.
 */

const NOON = new Date('2026-03-10T12:00:00.000Z');
const ID = 'storage+data';

let work;
let mail;
let usedPercent;

/** A disk of 1000 blocks of 1 KiB whose used share is `usedPercent` of the total. */
const fakeStatfs = async () => ({
  bsize: 1024, blocks: 1000, bfree: 1000 - usedPercent * 10, bavail: 1000 - usedPercent * 10
});

beforeEach(() => {
  work = scratchDir('fms-storage-alerts-');
  usedPercent = 50;
  fs.writeFileSync(path.join(work, 'test.db'), Buffer.alloc(10, 2));
  mail = captureTransport();
  setMailTransport(mail);
  vi.stubEnv('STAFF_ALERT_EMAIL', 'staff@example.test');
  setProbe({
    statfs: fakeStatfs,
    roles: { storage: paths.STORAGE_ROOT, data: work },
    directories: { ...DIRECTORY_PARTS, backups: path.join(work, 'backups') },
    dbPath: path.join(work, 'test.db')
  });
});

afterEach(() => {
  resetProbe();
  resetMailTransport();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  db.exec('DELETE FROM storage_days');
  db.exec("DELETE FROM settings WHERE key = 'storage_alerts'");
});

let people = 0;
const staffer = (accountType) => createUser({ username: `${accountType}-${(people += 1)}`, accountType });

/** The urgent messages an account holds, by subject. */
const alerts = (user) => db
  .prepare("SELECT subject FROM messages WHERE recipient_id = ? AND severity = 'urgent' ORDER BY rowid")
  .all(user.id)
  .map((row) => row.subject);

const runAt = async (percent) => {
  usedPercent = percent;
  await checkStorage(NOON);
};

describe('the disk-full alerts', () => {
  it('sends one mail when a disk reaches 80%, and nothing at the same level next hour', async () => {
    const admin = staffer('admin');

    await runAt(79);
    await runAt(80);
    await runAt(80);
    await runAt(85);

    expect(alerts(admin)).toEqual([`Disk ${ID} is 80% full`]);
    expect(mail.messages).toHaveLength(1);
  });

  it('sends the 90% mail next, once', async () => {
    const admin = staffer('admin');

    await runAt(80);
    await runAt(91);
    await runAt(95);

    expect(alerts(admin)).toEqual([`Disk ${ID} is 80% full`, `Disk ${ID} is 90% full`]);
  });

  it('sends only the 90% mail on a rise from under 80% to over 90% in one run', async () => {
    const admin = staffer('admin');

    await runAt(50);
    await runAt(93);

    expect(alerts(admin)).toEqual([`Disk ${ID} is 90% full`]);
    expect(mail.messages).toHaveLength(1);
  });

  it('sends no mail in a run where a role cannot be read, and none when the role returns', async () => {
    const admin = staffer('admin');
    const roles = { storage: paths.STORAGE_ROOT, data: work };

    await runAt(85);
    // A NUL in a path fails `stat` on every platform with an error that is not ENOENT.
    setProbe({ roles: { ...roles, data: '\0unreadable' } });
    await runAt(85);
    setProbe({ roles });
    await runAt(85);

    expect(alerts(admin)).toEqual([`Disk ${ID} is 80% full`]);
    expect(mail.messages).toHaveLength(1);
  });

  it('arms a level again after the disk drops below it', async () => {
    const admin = staffer('admin');

    await runAt(92);
    await runAt(60);
    await runAt(81);
    await runAt(95);

    expect(alerts(admin)).toEqual([`Disk ${ID} is 90% full`, `Disk ${ID} is 80% full`, `Disk ${ID} is 90% full`]);
  });

  it('arms only the 90% level on a drop from 95% to 85%', async () => {
    const admin = staffer('admin');

    await runAt(95);
    await runAt(85);
    await runAt(86);
    await runAt(92);

    expect(alerts(admin)).toEqual([`Disk ${ID} is 90% full`, `Disk ${ID} is 90% full`]);
  });

  it('names the filesystem, the used percent and the free space in the mail', async () => {
    staffer('admin');

    await runAt(85);

    expect(mail.messages).toHaveLength(1);
    const { subject, text } = mail.messages[0];
    expect(subject).toBe(`Disk ${ID} is 80% full`);
    expect(text).toContain(ID);
    expect(text).toContain('85.0% used');
    expect(text).toContain('150.0 KiB free');
  });

  it('stores the alert state before the mail goes out, so a failed mail does not repeat', async () => {
    const admin = staffer('admin');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempts = 0;
    let stateAtSend;
    setMailTransport({
      send: async () => {
        attempts += 1;
        stateAtSend = Setting.get('storage_alerts');
        throw new Error('SES refused the message');
      }
    });

    await runAt(85);
    await runAt(85);

    expect(stateAtSend).toEqual({ [ID]: 0.8 });
    expect(attempts).toBe(1);
    expect(alerts(admin)).toEqual([`Disk ${ID} is 80% full`]);
  });

  it('keeps the state through a run that cannot read the disk', async () => {
    const admin = staffer('admin');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await runAt(85);
    setProbe({ statfs: async () => { throw new Error('no statfs'); } });
    await checkStorage(NOON);
    setProbe({ statfs: fakeStatfs });
    await runAt(85);

    expect(alerts(admin)).toEqual([`Disk ${ID} is 80% full`]);
  });
});

describe('the report alert levels', () => {
  it('lists the level constants on every disk', async () => {
    const res = await request(app).get('/api/storage/report').set(authHeader(staffer('admin')));

    expect(res.body.data.disks).toHaveLength(1);
    expect(res.body.data.disks[0].alertLevels).toEqual([0.8, 0.9]);
  });
});
