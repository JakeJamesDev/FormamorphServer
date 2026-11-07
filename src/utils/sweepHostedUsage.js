const { hourly } = require('./hourly');
const HostedUsage = require('../models/HostedUsage');
const HostedRefusal = require('../models/HostedRefusal');
const Setting = require('../models/Setting');
const { HOSTED_AI } = require('../config/hostedAi');
const { DAY_MS } = require('../config/time');

/**
 * Settle Formamorph AI rows left open past the turn time limit, and delete rows and refusal totals past retention.
 *
 * An open row past the limit is a call whose settle never ran, as after a restart. It keeps its worst-case
 * reservation as an `estimated` cost. A setting an admin has not written skips its half.
 *
 * Never throws: this runs on a timer nobody is watching.
 *
 * @param {Date} [now] - The instant to measure from, for tests
 * @returns {{ settled: number, deleted: number, refusalsDeleted: number }} `deleted` counts usage rows
 */
const sweepHostedUsage = (now = new Date()) => {
  const swept = { settled: 0, deleted: 0, refusalsDeleted: 0 };

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

  if (settings.retentionDays) {
    const cutoff = new Date(now.getTime() - settings.retentionDays * DAY_MS).toISOString();
    try {
      swept.deleted = HostedUsage.deleteBefore(cutoff);
    } catch (error) {
      console.error('Hosted usage retention sweep failed:', error);
    }
    try {
      swept.refusalsDeleted = HostedRefusal.deleteBefore(cutoff);
    } catch (error) {
      console.error('Hosted refusal retention sweep failed:', error);
    }
  }

  return swept;
};

const startHostedUsageSweeper = () => hourly(() => sweepHostedUsage());

module.exports = { sweepHostedUsage, startHostedUsageSweeper };
