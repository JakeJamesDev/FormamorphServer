const HostedUsage = require('../models/HostedUsage');
const HostedUsageReport = require('../models/HostedUsageReport');
const HostedRefusal = require('../models/HostedRefusal');
const FunnelTotal = require('../models/FunnelTotal');
const ActiveInstall = require('../models/ActiveInstall');
const Setting = require('../models/Setting');
const { HOSTED_AI, MICROS_PER_DOLLAR, TIER_KEYS } = require('../config/hostedAi');
const { FUNNEL_STEPS } = require('../config/funnel');
const { DAY_MS, utcDay } = require('../config/time');
const { weekStart, resetAt } = require('./hostedMeter');
const { entitlement } = require('./hostedState');

const SLOWEST_LIMIT = 5;
const HEAVIEST_LIMIT = 5;

/** Nearest-rank percentile, or null for no values. */
const percentile = (values, share) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(share * sorted.length) - 1];
};

/** Output tokens per second after the first token, or null when the call has no such span. */
const tokensPerSecond = ({ outputTokens, durationMs, firstTokenMs }) => {
  const span = durationMs - firstTokenMs;
  return outputTokens > 0 && span > 0 ? (outputTokens * 1000) / span : null;
};

const present = (values) => values.filter((value) => value !== null && value !== undefined);

const sumCounts = (breakdown = []) => breakdown.reduce((sum, row) => sum + row.count, 0);

/** Distinct installs per UTC day since a day, all platforms and versions together. */
const installCounts = (sinceDay) => new Map([...ActiveInstall.daysSince(sinceDay)].map(([day, breakdown]) => [day, sumCounts(breakdown)]));

/**
 * Today, yesterday, this month, and the mean full day of this month. The mean starts at the month's first
 * counted day, so a month that began before counting did is not averaged over empty days.
 */
const activeFigures = (dayCounts, month, today, yesterday, monthStart) => {
  const counted = [...dayCounts.keys()].filter((day) => day >= monthStart && day < today && dayCounts.get(day) > 0).sort();
  let averageDay = null;
  if (counted.length) {
    const first = Date.parse(counted[0]);
    const span = (Date.parse(today) - first) / DAY_MS;
    let total = 0;
    for (let index = 0; index < span; index += 1) total += dayCounts.get(utcDay(new Date(first + index * DAY_MS))) || 0;
    averageDay = total / span;
  }

  return { today: dayCounts.get(today) || 0, yesterday: dayCounts.get(yesterday) || 0, month, averageDay };
};

/** Each platform and version's active installs today, yesterday and this month, most this month first. */
const buildRows = (days, month, today, yesterday) => {
  const builds = new Map();
  const add = (breakdown = [], field) => {
    for (const { platform, version, count } of breakdown) {
      const key = `${platform} ${version}`;
      if (!builds.has(key)) builds.set(key, { platform, version, today: 0, yesterday: 0, month: 0 });
      builds.get(key)[field] = count;
    }
  };
  add(days.get(today), 'today');
  add(days.get(yesterday), 'yesterday');
  add(month, 'month');

  return [...builds.values()].sort((a, b) => b.month - a.month || b.yesterday - a.yesterday || b.today - a.today);
};

/** Daily and monthly active app installs and Formamorph AI accounts, by UTC calendar month. */
const activeUsers = (now) => {
  const today = utcDay(now);
  const yesterday = utcDay(new Date(Date.parse(today) - DAY_MS));
  const monthStart = `${today.slice(0, 7)}-01`;
  const from = yesterday < monthStart ? yesterday : monthStart;
  const accountDays = new Map(HostedUsageReport.accountDays(`${from}T00:00:00.000Z`).map((row) => [row.day, row.count]));

  const installDays = ActiveInstall.daysSince(from);
  const installMonth = ActiveInstall.months().get(today.slice(0, 7));
  const installCountsByDay = new Map([...installDays].map(([day, breakdown]) => [day, sumCounts(breakdown)]));

  return {
    installs: activeFigures(installCountsByDay, sumCounts(installMonth), today, yesterday, monthStart),
    accounts: activeFigures(accountDays, HostedUsageReport.accountsSince(`${monthStart}T00:00:00.000Z`), today, yesterday, monthStart),
    builds: buildRows(installDays, installMonth, today, yesterday)
  };
};

/** Every day of the range, oldest first, so an idle day still takes its place on a chart. */
const dayRows = (dayNames, since) => {
  const usage = new Map(HostedUsageReport.days(since).map((row) => [row.day, row]));
  const provider = new Map(HostedUsage.providerDaysSince(dayNames[0]).map((row) => [row.day, row.providerMicros]));
  const installs = installCounts(dayNames[0]);
  const firstInstallDay = ActiveInstall.firstDay();

  // A day before counting began has no install count, which is not a count of zero.
  return dayNames.map((day) => ({
    day, calls: 0, turns: 0, accounts: 0, costMicros: 0, ...usage.get(day),
    providerMicros: provider.get(day) ?? null,
    installs: firstInstallDay && day >= firstInstallDay ? installs.get(day) || 0 : null
  }));
};

const promptTypeRows = (since) => {
  const timings = HostedUsageReport.timings(since);

  return HostedUsageReport.promptTypes(since).map(({ promptTokens, cachedTokens, ...row }) => {
    const own = timings.filter((timing) => timing.promptType === row.promptType);
    return {
      ...row,
      cachedShare: promptTokens > 0 ? cachedTokens / promptTokens : null,
      firstTokenP50Ms: percentile(own.map((timing) => timing.firstTokenMs), 0.5),
      tokensPerSecondP50: percentile(present(own.map(tokensPerSecond)), 0.5),
      maxGapP90Ms: percentile(present(own.map((timing) => timing.maxGapMs)), 0.9)
    };
  });
};

/** Settled cost over reservation, or null with nothing reserved. */
const withRatio = (row) => ({ ...row, ratio: row.reserveMicros > 0 ? row.costMicros / row.reserveMicros : null });

const reservationRows = (since) => {
  const promptTypes = HostedUsageReport.reservations(since);
  const sum = (field) => promptTypes.reduce((total, row) => total + row[field], 0);

  return {
    overall: withRatio({ calls: sum('calls'), reserveMicros: sum('reserveMicros'), costMicros: sum('costMicros') }),
    promptTypes: promptTypes.map(withRatio)
  };
};

const clientRows = (since) => {
  const without = new Map(HostedUsageReport.turnsWithoutNarration(since).map((row) => [row.clientVersion, row.turns]));

  return HostedUsageReport.clients(since).map((row) => ({ ...row, turnsWithoutNarration: without.get(row.clientVersion) || 0 }));
};

/** Each subject's share of its tier's weekly budget, null where the tier has no budget set. */
const budgetShares = (now) => {
  const tiers = Setting.get(HOSTED_AI)?.tiers || {};

  return new Map(HostedUsageReport.allowanceSpend(weekStart(now)).map(({ subject, tier, costMicros }) => {
    const budget = tiers[tier]?.budget;
    return [subject, { tier, share: budget ? costMicros / (budget * MICROS_PER_DOLLAR) : null }];
  }));
};

const tierRows = (since, shares, now) => {
  const entitled = new Map();
  for (const userId of HostedUsageReport.entitledCandidates(now.toISOString())) {
    const tier = entitlement(userId, now)?.tier;
    if (tier) entitled.set(tier, (entitled.get(tier) || 0) + 1);
  }
  const usage = new Map(HostedUsageReport.tiers(since).map((row) => [row.tier, row]));
  const allShares = [...shares.values()];

  return TIER_KEYS.map((tier) => {
    const own = present(allShares.filter((entry) => entry.tier === tier).map((entry) => entry.share));
    return {
      tier,
      entitled: entitled.get(tier) || 0,
      active: usage.get(tier)?.active || 0,
      turns: usage.get(tier)?.turns || 0,
      costMicros: usage.get(tier)?.costMicros || 0,
      topBudgetShare: own.length ? Math.max(...own) : null
    };
  });
};

/**
 * The admin usage report for the last `days` UTC days, today included. Tiers and the heaviest accounts cover
 * the current budget week instead, so they match the budget share beside them.
 *
 * Holds sums and call timings only. No account, subject or turn id leaves here.
 *
 * @param {number} days - Days in the range
 * @param {Date} [now] - The instant, for tests
 * @returns {Object}
 */
const buildUsageReport = (days, now = new Date()) => {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const since = new Date(today - (days - 1) * DAY_MS).toISOString();
  const dayNames = Array.from({ length: days }, (_, index) => new Date(today - (days - 1 - index) * DAY_MS).toISOString().slice(0, 10));
  const week = weekStart(now);
  const shares = budgetShares(now);
  const dayList = dayRows(dayNames, since);
  const { promptTokens, cachedTokens, ...totals } = HostedUsageReport.totals(since);
  const offer = FunnelTotal.sumsSince(dayNames[0]);

  return {
    since,
    week: { since: week, resetAt: resetAt(now) },
    activeUsers: activeUsers(now),
    totals: {
      ...totals,
      providerMicros: dayList.reduce((sum, day) => sum + (day.providerMicros || 0), 0),
      cachedShare: promptTokens > 0 ? cachedTokens / promptTokens : null
    },
    days: dayList,
    promptTypes: promptTypeRows(since),
    endings: HostedUsageReport.endings(since),
    failures: HostedUsageReport.failures(since),
    tiers: tierRows(week, shares, now),
    slowest: HostedUsageReport.slowest(since, SLOWEST_LIMIT).map(({ outputTokens, durationMs, ...row }) => ({
      ...row,
      tokensPerSecond: row.firstTokenMs === null ? null : tokensPerSecond({ outputTokens, durationMs, firstTokenMs: row.firstTokenMs })
    })),
    heaviest: HostedUsageReport.subjects(week).slice(0, HEAVIEST_LIMIT).map(({ subject, ...row }) => ({
      ...row, budgetShare: shares.get(subject)?.share ?? null
    })),
    reservations: reservationRows(since),
    clients: clientRows(since),
    offer: FUNNEL_STEPS.map((step) => ({ step, count: offer.get(step) || 0 })),
    refusals: {
      days: HostedRefusal.days(dayNames[0]),
      tiers: HostedRefusal.tiers(dayNames[0]),
      budgetExhaustedAccounts: HostedRefusal.accountsSince(dayNames[0], 'budget_exhausted')
    }
  };
};

module.exports = { buildUsageReport };
