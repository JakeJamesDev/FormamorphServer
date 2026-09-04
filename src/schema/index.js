/**
 * The database schema, and the one way to bring a database up to it.
 *
 * `migrate(db)` runs `STEPS` in order. Each step reads the live schema and changes only what is missing,
 * so a run is safe to repeat. A step may also seed a row the server ships with, on the same rule: it
 * writes only when the row is absent, so a later boot never overwrites an edited one. Tables come first
 * and indexes last, because an index may name a column a step adds. A step that rebuilds a table from a
 * fixed column list drops any column added before it, so a later column goes after the rebuild.
 *
 * Each step runs in its own transaction unless it says `atomic: false` and carries its own. A step that
 * throws stops the run, is rolled back, and is named in the error. The steps before it stay applied.
 */

const STEPS = [
  require('./tables'),
  require('./steps/kind'),
  require('./steps/quarantine'),
  require('./steps/avatar'),
  require('./steps/authorRole'),
  require('./steps/reporterRole'),
  require('./steps/actorRole'),
  require('./steps/feedbackEdited'),
  require('./steps/feedbackCommentEdited'),
  require('./steps/commentEdited'),
  require('./steps/feedSeen'),
  require('./steps/tokenVersion'),
  require('./steps/contest'),
  require('./steps/poster'),
  require('./steps/eventPlacements'),
  require('./steps/posterPlacement'),
  require('./steps/reportParent'),
  require('./steps/privacyPolicy'),
  require('./indexes')
];

/**
 * Bring a database up to the current schema.
 *
 * @param {Object} database - The connection to migrate
 * @returns {string[]} The names of the steps that changed something, in the order they ran
 * @throws {Error} The first step that fails, named, with the original error as its cause
 */
const migrate = (database) => {
  const applied = [];

  for (const step of STEPS) {
    const run = step.atomic === false ? step.apply : database.transaction(step.apply);
    let changed;

    try {
      changed = run(database);
    } catch (error) {
      throw new Error(`Schema step "${step.name}" failed: ${error.message}`, { cause: error });
    }

    if (changed) {
      applied.push(step.name);
      console.log(`Schema: applied ${step.name}`);
    }
  }

  return applied;
};

module.exports = { migrate };
