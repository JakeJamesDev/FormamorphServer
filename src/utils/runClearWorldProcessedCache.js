#!/usr/bin/env node

/**
 * Usage:
 *   npm run clear-world-cache              Count the cache files that would go
 *   npm run clear-world-cache -- --write   Delete them
 */

require('../config/loadEnv');
const { clearWorldProcessedCache } = require('./clearWorldProcessedCache');

const flags = process.argv.slice(2);
const unknown = flags.filter((flag) => flag !== '--write');

if (unknown.length > 0) {
  console.error(`Unknown flag: ${unknown.join(' ')}`);
  process.exit(1);
}

clearWorldProcessedCache({ write: flags.includes('--write') })
  .then(({ found, deleted }) => console.log(`found=${found} deleted=${deleted}`))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
