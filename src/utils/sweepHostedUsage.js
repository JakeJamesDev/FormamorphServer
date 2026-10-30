const { hourly } = require('./hourly');
const HostedUsage = require('../models/HostedUsage');
const Setting = require('../models/Setting');
const { HOSTED_AI } = require('../config/hostedAi');
const { DAY_MS } = require('../config/time');

/**
 * Settle Formamorph AI rows left open past the turn time limit, and delete rows past retention.
 *
 * An open row past the limit is a call whose settle never ran, as after a restart. It keeps its worst-case
 * reservation as an `estimated` cost. A setting an admin has not written skips its half.
 *
 * Never throws: this runs on a timer nobody is watching.
 *
 * @param {Date} [now] - The instant to measure from, for tests
 * @returns {{ settled: number, deleted: number }}
 */
const sweepHostedUsage = (now = new Date()) => {
  const swept = { settled: 0, deleted: 0 };

  let settings;
  try {
    settings = Setting.get(HOSTED_AI) || {};
  } catch (error) {
    console.error('Hosted usage sweep could not read its settings:', error);
    return swept;
  }

  try {
    if (settings.turnLimitSeconds) {
      swept.settled = HostedUsage.sweepOpen(new Date(now.getTime() - settings.turnLimitSeconds * 1000).toISOString());
    }
  } catch (error) {
    console.error('Hosted usage settle sweep failed:', error);
  }

  try {
    if (settings.retentionDays) {
      swept.deleted = HostedUsage.deleteBefore(new Date(now.getTime() - settings.retentionDays * DAY_MS).toISOString());
    }
  } catch (error) {
    console.error('Hosted usage retention sweep failed:', error);
  }

  return swept;
};

const startHostedUsageSweeper = () => hourly(() => sweepHostedUsage());

module.exports = { sweepHostedUsage, startHostedUsageSweeper };
