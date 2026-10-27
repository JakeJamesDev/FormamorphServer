const { PLACEHOLDER_ID } = require('../config/accountDeletion');

/** Whether an account may be read through either public profile lookup. */
const shownPublicly = (user) => Boolean(user) && user.status !== 'suspended';

/**
 * Whether a name may lead a stranger to this account at all.
 *
 * @param {Object} user - A candidate the name matched
 * @returns {boolean} Whether the profile is shown
 */
const shownByName = (user) => shownPublicly(user) && user.id !== PLACEHOLDER_ID;

/**
 * The account a typed name reaches, among the accounts holding it in any capitals.
 *
 * Two accounts can hold one name in different capitals, so the pick is in two parts. Asked for a name
 * byte for byte, that account answers, shown or refused on its own status — a suspended account is not
 * reachable by spelling it differently. Asked for a spelling nobody holds, the oldest account still
 * shown answers, so a live creator's link keeps working even when a suspended namesake is older.
 *
 * @param {Array<Object>} candidates - Rows matching the name folded, oldest first, suspensions lifted
 * @param {string} named - The name as typed
 * @returns {Object|null} The account, or null when the name reaches none
 */
const pickByName = (candidates, named) => {
  const user = candidates.find((row) => row.username === named) || candidates.find(shownByName);
  return user && shownByName(user) ? user : null;
};

module.exports = { shownPublicly, pickByName };
