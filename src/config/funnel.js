/**
 * The steps of the Formamorph AI offer that the client counts, and the budget for counting them.
 *
 * A step is a name on the wire, never a free string, so a typo or a probe cannot add a row. The limiter
 * keeps its counts in memory and keys on the address; the address is never written to the database.
 *
 * Its own module so the route and the tests name one list and one number.
 */

const { MINUTE_MS } = require('./time');

const FUNNEL_STEPS = ['offer_shown', 'local_offer_shown', 'see_levels', 'patreon_click', 'checklist_finished'];

const FUNNEL_WINDOW_MS = MINUTE_MS;
const FUNNEL_LIMIT = 30;

module.exports = { FUNNEL_STEPS, FUNNEL_WINDOW_MS, FUNNEL_LIMIT };
