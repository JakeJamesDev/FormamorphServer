const { hourly } = require('./hourly');
const { listMembers } = require('./patreon');
const { refreshTierNames } = require('./tierNames');
const { alertAdmins } = require('./hostedAlerts');
const PatreonLink = require('../models/PatreonLink');
const Setting = require('../models/Setting');
const { patreonConfigured, tierStateOf } = require('../config/patreon');
const { PATREON_RECONCILE_FAILURES } = require('../config/settings');

/** Consecutive failed hourly reconciles that raise the admin alert. */
const ALERT_AFTER_FAILURES = 3;

/**
 * Set every link's tier from the full campaign member list.
 *
 * The shared read: it neither counts failures nor alerts. A failed read throws and changes no link.
 *
 * @returns {Promise<number>} How many links were set
 */
const refreshLinksFromMembers = async () => {
  const members = new Map((await listMembers()).map((member) => [member.patreonUserId, member]));
  return PatreonLink.setAllTiers((id) => tierStateOf(members.get(id) || null), new Date().toISOString());
};

/** Count one failed hourly run, and alert the admins once, on the run that reaches the threshold. */
const recordFailure = async () => {
  const failures = (Setting.get(PATREON_RECONCILE_FAILURES) || 0) + 1;
  Setting.set(PATREON_RECONCILE_FAILURES, failures);
  if (failures !== ALERT_AFTER_FAILURES) return;

  await alertAdmins({
    subject: 'Patreon reconcile is failing',
    body: `The hourly Patreon reconcile has failed ${ALERT_AFTER_FAILURES} times in a row. Supporters keep service until a pledge has gone 7 days unconfirmed. Check the creator token and Patreon's status.`
  });
};

/**
 * Set every link's tier from the full campaign member list.
 *
 * Run at boot and then hourly, so a webhook that never arrived is repaired within the hour. A link whose
 * member is absent from the list gets no tier and stays linked. A failed read changes no link.
 *
 * The tier names refresh in the same pass, and a failed read of them changes no name.
 *
 * Counts failed runs: the third in a row alerts the admins once, and a success clears the count.
 *
 * Never throws. A server without Patreon set up does nothing and counts nothing.
 *
 * @returns {Promise<number|null>} How many links were set, or null when nothing ran
 */
const reconcilePatreon = async () => {
  if (!patreonConfigured()) return null;

  await refreshTierNames();

  try {
    const set = await refreshLinksFromMembers();
    if (Setting.get(PATREON_RECONCILE_FAILURES)) Setting.set(PATREON_RECONCILE_FAILURES, 0);
    return set;
  } catch (error) {
    console.error('Patreon reconcile failed:', error);
    try {
      await recordFailure();
    } catch (countError) {
      console.error('Patreon reconcile failure count failed:', countError);
    }
    return null;
  }
};

const startPatreonReconciler = () => hourly(reconcilePatreon);

module.exports = { reconcilePatreon, refreshLinksFromMembers, startPatreonReconciler };
