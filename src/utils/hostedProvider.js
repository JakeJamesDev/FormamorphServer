const Setting = require('../models/Setting');
const HostedProviderSpend = require('../models/HostedProviderSpend');
const { hourly } = require('./hourly');
const { alertAdmins } = require('./hostedAlerts');
const { utcDay, daySpend } = require('./hostedPause');
const {
  HOSTED_AI, HOSTED_BALANCE_ALERTED, MICROS_PER_DOLLAR, balanceUrl, usageUrl, upstreamKey
} = require('../config/hostedAi');
const { DAY_MS } = require('../config/time');

/**
 * The provider account behind Formamorph AI, read with the server key: its balance, and its spend per UTC day.
 *
 * Both endpoints come from the environment. A job with no URL, key or threshold skips its run.
 */

/** Complete days every run reads again, so a late provider figure or a late settle corrects them. */
const REREAD_DAYS = 2;

/** The account balance in dollars. */
const readBalance = async () => {
  const response = await fetch(balanceUrl(), { method: 'POST', headers: { 'x-api-key': upstreamKey() } });
  if (!response.ok) throw new Error(`The balance read answered ${response.status}`);
  const balance = Number.parseFloat((await response.json())?.usd_balance);
  if (!Number.isFinite(balance)) throw new Error('The balance reply has no usd_balance');

  return balance;
};

/**
 * Read the balance and alert the admins once when it is below the threshold. A reading at or above the
 * threshold re-arms the alert.
 *
 * Never throws: this runs on a timer nobody is watching.
 *
 * @returns {Promise<number|null>} The balance in dollars, or null when the run was skipped or failed
 */
const checkProviderBalance = async () => {
  try {
    const threshold = (Setting.get(HOSTED_AI) || {}).balanceThreshold;
    if (typeof threshold !== 'number' || !balanceUrl() || !upstreamKey()) return null;

    const balance = await readBalance();
    const alerted = Setting.get(HOSTED_BALANCE_ALERTED) === true;
    if (balance >= threshold) {
      if (alerted) Setting.set(HOSTED_BALANCE_ALERTED, false);
    } else if (!alerted) {
      Setting.set(HOSTED_BALANCE_ALERTED, true);
      await alertAdmins({
        subject: 'Formamorph AI provider balance is low',
        body: `The provider account balance is $${balance.toFixed(2)}, below the alert threshold. Top it up before it runs out.`
      });
    }

    return balance;
  } catch (error) {
    console.error('Provider balance check failed:', error.message);
    return null;
  }
};

/** Each UTC day from `fromDay` to `toDay`, inclusive. */
const daysBetween = (fromDay, toDay) => {
  const days = [];
  for (let time = Date.parse(fromDay); time <= Date.parse(toDay); time += DAY_MS) days.push(utcDay(new Date(time)));
  return days;
};

/**
 * Store the provider's spend for every complete UTC day since the last stored one, and the last two again,
 * beside the day's recorded sum. With nothing stored, it reads the last two.
 *
 * Never throws: this runs on a timer nobody is watching.
 *
 * @param {Date} [now] - The instant to measure from, for tests
 * @returns {Promise<number>} Days stored
 */
const recordProviderSpend = async (now = new Date()) => {
  try {
    if (!usageUrl() || !upstreamKey()) return 0;

    const yesterday = utcDay(new Date(now.getTime() - DAY_MS));
    const reread = utcDay(new Date(now.getTime() - REREAD_DAYS * DAY_MS));
    const last = HostedProviderSpend.lastDay();
    const after = last ? utcDay(new Date(Date.parse(last) + DAY_MS)) : reread;
    const from = after < reread ? after : reread;

    const url = new URL(usageUrl());
    url.searchParams.set('from', from);
    url.searchParams.set('to', yesterday);
    url.searchParams.set('group_by', 'day');
    const response = await fetch(url, { headers: { Authorization: `Bearer ${upstreamKey()}` } });
    if (!response.ok) throw new Error(`The usage read answered ${response.status}`);
    const reply = await response.json();
    if (!Array.isArray(reply?.byDay)) throw new Error('The usage reply has no byDay');

    // A day the reply leaves out had no spend.
    const spent = new Map();
    for (const entry of reply.byDay) {
      if (typeof entry?.date !== 'string' || typeof entry.netCostUsd !== 'number') throw new Error('A usage day is malformed');
      const day = entry.date.slice(0, 10);
      spent.set(day, (spent.get(day) || 0) + entry.netCostUsd);
    }

    const days = daysBetween(from, yesterday);
    const readAt = now.toISOString();
    for (const day of days) {
      HostedProviderSpend.record({
        day,
        providerMicros: Math.round((spent.get(day) || 0) * MICROS_PER_DOLLAR),
        recordedMicros: daySpend(day),
        readAt
      });
    }

    return days.length;
  } catch (error) {
    console.error('Provider spend read failed:', error.message);
    return 0;
  }
};

/** Check the balance, then store the provider's spend. */
const monitorProvider = async () => {
  await checkProviderBalance();
  await recordProviderSpend();
};

const startHostedMonitors = () => hourly(monitorProvider);

module.exports = { checkProviderBalance, recordProviderSpend, monitorProvider, startHostedMonitors };
