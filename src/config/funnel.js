/**
 * The steps of the Formamorph AI offer that the client counts, and the budget for counting them.
 *
 * A step is a name on the wire, never a free string, so a typo or a probe cannot add a row. The limiter
 * keeps its counts in memory and keys on the address; the address is never written to the database.
 *
 * Its own module so the route and the tests name one list and one number.
 */

const { MINUTE_MS } = require('./time');

// A step is `<source>_<step>`. Only some pairs exist: the notice and locked sources have no shown step.
const SOURCE_STEPS = {
  setup: ['offer_shown', 'see_levels', 'patreon_click', 'checklist_finished'],
  demo: ['offer_shown', 'see_levels', 'patreon_click', 'checklist_finished'],
  engine: ['offer_shown', 'see_levels', 'patreon_click', 'checklist_finished'],
  notice: ['see_levels', 'patreon_click', 'checklist_finished'],
  locked: ['see_levels', 'patreon_click', 'checklist_finished']
};

// Names that v3.6.2 clients send, with no source.
const LEGACY_FUNNEL_STEPS = ['offer_shown', 'see_levels', 'patreon_click', 'checklist_finished'];

const FUNNEL_STEPS = [
  ...LEGACY_FUNNEL_STEPS,
  ...Object.entries(SOURCE_STEPS).flatMap(([source, steps]) => steps.map((step) => `${source}_${step}`))
];

const FUNNEL_WINDOW_MS = MINUTE_MS;
const FUNNEL_LIMIT = 30;

module.exports = { FUNNEL_STEPS, LEGACY_FUNNEL_STEPS, SOURCE_STEPS, FUNNEL_WINDOW_MS, FUNNEL_LIMIT };
