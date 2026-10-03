const { hourly } = require('./hourly');
const { listMembers } = require('./patreon');
const PatreonLink = require('../models/PatreonLink');
const { patreonConfigured, tierStateOf } = require('../config/patreon');

/**
 * Set every link's tier from the full campaign member list.
 *
 * Run at boot and then hourly, so a webhook that never arrived is repaired within the hour. A link whose
 * member is absent from the list gets no tier and stays linked. A failed read changes no link.
 *
 * Never throws. A server without Patreon set up does nothing.
 *
 * @returns {Promise<number|null>} How many links were set, or null when nothing ran
 */
const reconcilePatreon = async () => {
  if (!patreonConfigured()) return null;

  try {
    const members = new Map((await listMembers()).map((member) => [member.patreonUserId, member]));
    return PatreonLink.setAllTiers((id) => tierStateOf(members.get(id) || null), new Date().toISOString());
  } catch (error) {
    console.error('Patreon reconcile failed:', error);
    return null;
  }
};

const startPatreonReconciler = () => hourly(reconcilePatreon);

module.exports = { reconcilePatreon, startPatreonReconciler };
