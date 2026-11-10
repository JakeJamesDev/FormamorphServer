import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'module';
import { app, request, db } from './context.js';
import { createUser, authHeader } from './helpers.js';

const require = createRequire(import.meta.url);
const {
  setMailTransport, resetMailTransport, captureTransport, setSesClient, resetSesClient
} = require('../src/utils/mail');
const { checkMailHealth } = require('../src/utils/mailHealth');
const { DAY_MS, utcDay } = require('../src/config/time');

/**
 * The hourly SES account and rate check, and the admin mail report.
 *
 * SES is a fake client whose GetAccount answer each test sets. Mail-log rows are seeded straight into the
 * table, the way SES events would have left them.
 */

const REPORT = '/api/mail/report';

let account;
let accountReads;
let mail;

const sesAnswer = ({ status = 'HEALTHY', sending = true, sent = 12, quota = 50000 } = {}) => ({
  EnforcementStatus: status,
  SendingEnabled: sending,
  SendQuota: { Max24HourSend: quota, MaxSendRate: 14, SentLast24Hours: sent }
});

const fakeSes = {
  getAccount: async () => {
    accountReads += 1;
    if (account instanceof Error) throw account;
    return account;
  }
};

beforeEach(() => {
  account = sesAnswer();
  accountReads = 0;
  setSesClient(fakeSes);
  mail = captureTransport();
  setMailTransport(mail);
});

afterEach(() => {
  resetSesClient();
  resetMailTransport();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  db.exec('DELETE FROM mail_log');
  db.exec("DELETE FROM settings WHERE key IN ('mail_ses_account', 'mail_alerts')");
});

let seeded = 0;
/** `count` mail-log rows sent at `at`, in one status. */
const seed = (count, { status = 'delivered', bounceType = null, at = new Date(Date.now() - DAY_MS) } = {}) => {
  const insert = db.prepare(`
    INSERT INTO mail_log (id, user_id, kind, message_id, status, bounce_type, sent_at, status_at)
    VALUES (?, NULL, 'verify', NULL, ?, ?, ?, ?)
  `);
  for (let index = 0; index < count; index += 1) {
    seeded += 1;
    insert.run(`seed-${seeded}`, status, bounceType, at.toISOString(), at.toISOString());
  }
};

const hardBounces = (count, at) => seed(count, { status: 'bounced', bounceType: 'hard', at });
const complaints = (count, at) => seed(count, { status: 'complained', at });

let people = 0;
const staffer = (accountType) => createUser({ username: `${accountType}-${(people += 1)}`, accountType });

/** The urgent messages an account holds, by subject. */
const alerts = (user) => db
  .prepare("SELECT subject FROM messages WHERE recipient_id = ? AND severity = 'urgent' ORDER BY rowid")
  .all(user.id)
  .map((row) => row.subject);

describe('the mail report', () => {
  it('counts each UTC send day by status, newest first, with empty days zero-filled', async () => {
    const now = Date.now();
    const twoDaysAgo = new Date(now - 2 * DAY_MS);
    seed(3, { at: new Date(now) });
    seed(1, { status: 'sent', at: new Date(now) });
    seed(2, { status: 'delayed', at: twoDaysAgo });
    hardBounces(1, twoDaysAgo);
    seed(2, { status: 'bounced', bounceType: 'soft', at: twoDaysAgo });
    complaints(1, twoDaysAgo);

    const res = await request(app).get(`${REPORT}?days=4`).set(authHeader(staffer('admin')));

    expect(res.status).toBe(200);
    expect(res.body.data.days).toEqual([
      { day: utcDay(new Date(now)), sent: 4, delivered: 3, delayed: 0, hardBounced: 0, softBounced: 0, complained: 0 },
      { day: utcDay(new Date(now - DAY_MS)), sent: 0, delivered: 0, delayed: 0, hardBounced: 0, softBounced: 0, complained: 0 },
      { day: utcDay(twoDaysAgo), sent: 6, delivered: 0, delayed: 2, hardBounced: 1, softBounced: 2, complained: 1 },
      { day: utcDay(new Date(now - 3 * DAY_MS)), sent: 0, delivered: 0, delayed: 0, hardBounced: 0, softBounced: 0, complained: 0 }
    ]);
  });

  it('returns both 7-day rates with their volume, the limits, the last SES status and the 24-hour quota use', async () => {
    seed(190);
    hardBounces(8);
    complaints(2);
    seed(50, { at: new Date(Date.now() - 8 * DAY_MS) });
    account = sesAnswer({ sent: 321, quota: 50000 });
    await checkMailHealth();

    const res = await request(app).get(REPORT).set(authHeader(staffer('admin')));

    expect(res.body.data.days).toHaveLength(30);
    expect(res.body.data.rates).toEqual({
      windowDays: 7,
      minVolume: 200,
      volume: 200,
      measured: true,
      bounce: { count: 8, rate: 0.04, limits: { alert: 0.025, review: 0.05, pause: 0.1 } },
      complaint: { count: 2, rate: 0.01, limits: { alert: 0.0005, review: 0.001, pause: 0.005 } }
    });
    expect(res.body.data.ses).toEqual({ enforcementStatus: 'HEALTHY', sendingEnabled: true, checkedAt: expect.any(String) });
    expect(res.body.data.last24Hours).toEqual({ sent: 321, quota: 50000 });
  });

  it('reads as not measured under the volume floor, and holds no SES status before the first read', async () => {
    seed(10);
    hardBounces(5);

    const res = await request(app).get(REPORT).set(authHeader(staffer('admin')));

    expect(res.body.data.rates).toMatchObject({ volume: 15, measured: false });
    expect(res.body.data.ses).toBeNull();
    expect(res.body.data.last24Hours).toBeNull();
  });

  it('refuses a moderator and a guest', async () => {
    const asMod = await request(app).get(REPORT).set(authHeader(staffer('mod')));
    const asGuest = await request(app).get(REPORT);

    expect(asMod.status).toBe(403);
    expect(asGuest.status).toBe(401);
  });

  it('refuses a day count outside retention', async () => {
    const res = await request(app).get(`${REPORT}?days=91`).set(authHeader(staffer('admin')));

    expect(res.status).toBe(400);
  });
});

describe('the SES status alert', () => {
  it('alerts admins once for a non-healthy status, and nothing on the next run with the same status', async () => {
    const admin = staffer('admin');
    const mod = staffer('mod');
    account = sesAnswer({ status: 'PROBATION' });

    await checkMailHealth();
    await checkMailHealth();

    expect(alerts(admin)).toEqual(['Amazon SES is reviewing the mail account']);
    expect(alerts(mod)).toEqual([]);
  });

  it('alerts again after the status was healthy and then failed again', async () => {
    const admin = staffer('admin');

    account = sesAnswer({ status: 'PROBATION' });
    await checkMailHealth();
    account = sesAnswer();
    await checkMailHealth();
    account = sesAnswer({ status: 'PROBATION' });
    await checkMailHealth();

    expect(alerts(admin)).toHaveLength(2);
  });

  it('alerts again when a review becomes a pause', async () => {
    const admin = staffer('admin');

    account = sesAnswer({ status: 'PROBATION' });
    await checkMailHealth();
    account = sesAnswer({ status: 'SHUTDOWN', sending: false });
    await checkMailHealth();

    expect(alerts(admin)).toEqual(['Amazon SES is reviewing the mail account', 'Amazon SES paused the mail account']);
  });

  it('treats sending turned off on a healthy account as not healthy', async () => {
    const admin = staffer('admin');
    account = sesAnswer({ sending: false });

    await checkMailHealth();

    expect(alerts(admin)).toEqual(['Amazon SES sending is off']);
  });

  it('logs a failed read, alerts nothing, and keeps the last status with its time', async () => {
    const admin = staffer('admin');
    await checkMailHealth();
    const before = (await request(app).get(REPORT).set(authHeader(admin))).body.data.ses;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    account = new Error('throttled');

    const result = await checkMailHealth();
    const after = (await request(app).get(REPORT).set(authHeader(admin))).body.data.ses;

    expect(result).not.toBeNull();
    expect(logged).toHaveBeenCalledWith('SES account check failed:', expect.stringContaining('throttled'));
    expect(alerts(admin)).toEqual([]);
    expect(after).toEqual(before);
  });
});

describe('the hourly check', () => {
  it('still checks the rates when the SES read fails', async () => {
    const admin = staffer('admin');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    account = new Error('throttled');
    seed(195);
    hardBounces(5);

    await checkMailHealth();

    expect(alerts(admin)).toEqual(['Mail bounce rate is high']);
  });

  it('creates the urgent message even when the alert mail fails to send', async () => {
    const admin = staffer('admin');
    vi.stubEnv('STAFF_ALERT_EMAIL', 'staff@example.test');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setMailTransport({ send: async () => { throw new Error('SES refused the message'); } });
    account = sesAnswer({ status: 'SHUTDOWN' });
    seed(193);
    hardBounces(5);
    complaints(2);

    await checkMailHealth();

    expect(alerts(admin)).toEqual(['Amazon SES paused the mail account', 'Mail bounce rate is high', 'Mail complaint rate is high']);
  });

  it('mails the staff address beside the message when one is set', async () => {
    vi.stubEnv('STAFF_ALERT_EMAIL', 'staff@example.test');
    staffer('admin');
    account = sesAnswer({ status: 'PROBATION' });

    await checkMailHealth();

    expect(mail.messages).toEqual([expect.objectContaining({ to: 'staff@example.test', subject: 'Amazon SES is reviewing the mail account' })]);
  });

  it('does nothing when mail is off', async () => {
    const admin = staffer('admin');
    resetSesClient();
    seed(195);
    hardBounces(5);

    const result = await checkMailHealth();

    expect(result).toBeNull();
    expect(accountReads).toBe(0);
    expect(alerts(admin)).toEqual([]);
  });
});

describe('the rate alerts', () => {
  it('alerts once when hard bounces reach 2.5% of 200 mails', async () => {
    const admin = staffer('admin');
    seed(195);
    hardBounces(5);

    await checkMailHealth();
    await checkMailHealth();

    expect(alerts(admin)).toEqual(['Mail bounce rate is high']);
  });

  it('stays quiet at the same rate with 199 mails', async () => {
    const admin = staffer('admin');
    seed(194);
    hardBounces(5);

    await checkMailHealth();

    expect(alerts(admin)).toEqual([]);
  });

  it('stays quiet just under 2.5%, and counts no soft bounce', async () => {
    const admin = staffer('admin');
    seed(186);
    hardBounces(4);
    seed(10, { status: 'bounced', bounceType: 'soft' });

    await checkMailHealth();

    expect(alerts(admin)).toEqual([]);
  });

  it('alerts once when complaints reach 0.05% of 2,000 mails', async () => {
    const admin = staffer('admin');
    seed(1999);
    complaints(1);

    await checkMailHealth();
    await checkMailHealth();

    expect(alerts(admin)).toEqual(['Mail complaint rate is high']);
  });

  it('stays quiet at one complaint in 2,001 mails', async () => {
    const admin = staffer('admin');
    seed(2000);
    complaints(1);

    await checkMailHealth();

    expect(alerts(admin)).toEqual([]);
  });

  it('counts only the last 7 days', async () => {
    const admin = staffer('admin');
    seed(195);
    hardBounces(5, new Date(Date.now() - 8 * DAY_MS));

    await checkMailHealth();

    expect(alerts(admin)).toEqual([]);
  });

  it('re-arms when the rate falls below the limit, and alerts again when it returns', async () => {
    const admin = staffer('admin');
    seed(195);
    hardBounces(5);
    await checkMailHealth();
    seed(100);
    await checkMailHealth();
    hardBounces(5);
    await checkMailHealth();

    expect(alerts(admin)).toEqual(['Mail bounce rate is high', 'Mail bounce rate is high']);
  });

  it('keeps its state while the volume is under the floor', async () => {
    const admin = staffer('admin');
    const old = new Date(Date.now() - 6.5 * DAY_MS);
    seed(100, { at: old });
    seed(95);
    hardBounces(5);
    await checkMailHealth();

    // The old half leaves the window: 100 mails, 5% bounced, but not measured.
    await checkMailHealth(new Date(Date.now() + DAY_MS));
    seed(100);
    await checkMailHealth(new Date(Date.now() + DAY_MS));

    expect(alerts(admin)).toEqual(['Mail bounce rate is high']);
  });
});
