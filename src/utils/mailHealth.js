const MailLog = require('../models/MailLog');
const Setting = require('../models/Setting');
const { readSesAccount } = require('./mail');
const { alertAdmins } = require('./hostedAlerts');
const { hourly } = require('./hourly');
const {
  RATE_WINDOW_DAYS, MIN_RATE_VOLUME, RATE_LIMITS, MAIL_SES_ACCOUNT, MAIL_ALERTS
} = require('../config/mail');
const { DAY_MS, utcDay } = require('../config/time');

/**
 * Mail health: the SES account's standing, and the 7-day hard-bounce and complaint rates from the mail log.
 * Amazon sends no event when it reviews or pauses an account, so the job asks every hour.
 */

const PARTS = 10000;

/** Whether `count` of `volume` is at or above a limit in parts per 10,000. Integer math, so 5 of 200 is 2.5%. */
const reaches = (count, volume, limit) => count * PARTS >= volume * limit;

/**
 * The 7-day counts and whether each rate reaches its alert limit. Under the volume floor nothing is measured.
 *
 * @param {Date} now - The instant to measure back from
 * @returns {{ volume: number, hardBounces: number, complaints: number, measured: boolean,
 *   bounceHigh: boolean, complaintHigh: boolean }} The window
 */
const rateWindow = (now) => {
  const { volume, hardBounces, complaints } = MailLog.rateCounts(new Date(now.getTime() - RATE_WINDOW_DAYS * DAY_MS).toISOString());
  const measured = volume >= MIN_RATE_VOLUME;

  return {
    volume,
    hardBounces,
    complaints,
    measured,
    bounceHigh: measured && reaches(hardBounces, volume, RATE_LIMITS.bounce.alert),
    complaintHigh: measured && reaches(complaints, volume, RATE_LIMITS.complaint.alert)
  };
};

/** The account's alert state: null when healthy, otherwise a key that changes with each different trouble. */
const troubleOf = ({ enforcementStatus, sendingEnabled }) => {
  if (enforcementStatus === 'HEALTHY' && sendingEnabled !== false) return null;
  return `${enforcementStatus ?? 'UNKNOWN'}${sendingEnabled === false ? ':sending-off' : ''}`;
};

const statusAlert = ({ enforcementStatus, sendingEnabled }) => {
  const sending = sendingEnabled === false ? 'off' : 'on';
  const body = `Amazon SES reports the account status as ${enforcementStatus ?? 'unknown'}, with sending ${sending}. Check the SES console.`;
  if (enforcementStatus === 'SHUTDOWN') return { subject: 'Amazon SES paused the mail account', body };
  if (enforcementStatus === 'PROBATION') return { subject: 'Amazon SES is reviewing the mail account', body };
  if (sendingEnabled === false) return { subject: 'Amazon SES sending is off', body };
  return { subject: `Amazon SES account status is ${enforcementStatus ?? 'unknown'}`, body };
};

const percent = (count, volume) => `${((count * 100) / volume).toFixed(2)}%`;

/**
 * Read the SES account and the 7-day rates, and alert the admins once per condition. A condition that
 * clears re-arms its alert; a rate under the volume floor leaves its alert state as it is.
 *
 * Never throws: this runs on a timer nobody is watching.
 *
 * @param {Date} [now] - The instant to measure from, for tests
 * @returns {Promise<Object|null>} What the run found, or null when mail is off or the run failed
 */
const checkMailHealth = async (now = new Date()) => {
  try {
    let account = null;
    try {
      account = await readSesAccount();
      if (!account) return null;
      Setting.set(MAIL_SES_ACCOUNT, { ...account, checkedAt: now.toISOString() });
    } catch (error) {
      console.error('SES account check failed:', error.message);
    }

    const alerts = { ...Setting.get(MAIL_ALERTS) };
    const pending = [];

    if (account) {
      const trouble = troubleOf(account);
      if (trouble !== alerts.status) {
        if (trouble) pending.push(statusAlert(account));
        alerts.status = trouble;
      }
    }

    const recent = rateWindow(now);
    if (recent.measured) {
      if (recent.bounceHigh && !alerts.bounce) {
        pending.push({
          subject: 'Mail bounce rate is high',
          body: `${percent(recent.hardBounces, recent.volume)} of the last ${RATE_WINDOW_DAYS} days' ${recent.volume} mails hard-bounced. Amazon reviews the account at ${RATE_LIMITS.bounce.review / 100}%.`
        });
      }
      if (recent.complaintHigh && !alerts.complaint) {
        pending.push({
          subject: 'Mail complaint rate is high',
          body: `${percent(recent.complaints, recent.volume)} of the last ${RATE_WINDOW_DAYS} days' ${recent.volume} mails drew a spam complaint. Amazon reviews the account at ${RATE_LIMITS.complaint.review / 100}%.`
        });
      }
      alerts.bounce = recent.bounceHigh;
      alerts.complaint = recent.complaintHigh;
    }

    // Stored before the alerts go out, so a slow or failed alert mail is never repeated next hour.
    Setting.set(MAIL_ALERTS, alerts);
    for (const alert of pending) await alertAdmins(alert);

    return { account, recent, alerted: pending.map((alert) => alert.subject) };
  } catch (error) {
    console.error('Mail health check failed:', error.message);
    return null;
  }
};

const startMailHealthMonitor = () => hourly(checkMailHealth);

const fraction = (count, volume) => (volume > 0 ? count / volume : null);

const limitsOf = ({ alert, review, pause }) => ({ alert: alert / PARTS, review: review / PARTS, pause: pause / PARTS });

/**
 * The admin mail report: per-day counts, newest first, the 7-day rates beside Amazon's limits, and the last
 * SES account read.
 *
 * @param {number} days - UTC days to list, today included
 * @param {Date} [now] - The instant to report at, for tests
 * @returns {Object} The report
 */
const buildMailReport = (days, now = new Date()) => {
  const today = Date.parse(utcDay(now));
  const firstDay = new Date(today - (days - 1) * DAY_MS).toISOString();
  const counted = new Map(MailLog.daysSince(firstDay).map((row) => [row.day, row]));

  const byDay = [];
  for (let index = 0; index < days; index += 1) {
    const day = utcDay(new Date(today - index * DAY_MS));
    byDay.push(counted.get(day) || { day, ...Object.fromEntries(MailLog.DAY_COUNTS.map((count) => [count, 0])) });
  }

  const recent = rateWindow(now);
  const account = Setting.get(MAIL_SES_ACCOUNT);

  return {
    days: byDay,
    rates: {
      windowDays: RATE_WINDOW_DAYS,
      minVolume: MIN_RATE_VOLUME,
      volume: recent.volume,
      measured: recent.measured,
      bounce: { count: recent.hardBounces, rate: fraction(recent.hardBounces, recent.volume), limits: limitsOf(RATE_LIMITS.bounce) },
      complaint: { count: recent.complaints, rate: fraction(recent.complaints, recent.volume), limits: limitsOf(RATE_LIMITS.complaint) }
    },
    ses: account
      ? { enforcementStatus: account.enforcementStatus, sendingEnabled: account.sendingEnabled, checkedAt: account.checkedAt }
      : null,
    last24Hours: account ? { sent: account.sentLast24Hours, quota: account.max24HourSend } : null
  };
};

module.exports = { checkMailHealth, startMailHealthMonitor, buildMailReport };
