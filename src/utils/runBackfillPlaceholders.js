#!/usr/bin/env node

/**
 * Usage:
 *   npm run backfill-placeholders              Count the listings that would be flagged
 *   npm run backfill-placeholders -- --write   Flag them
 */

require('dotenv').config();
const { backfillPlaceholders } = require('./backfillPlaceholders');

const flags = process.argv.slice(2);
const unknown = flags.filter((flag) => flag !== '--write');

if (unknown.length > 0) {
  console.error(`Unknown flag: ${unknown.join(' ')}`);
  process.exit(1);
}

try {
  const { found, flagged } = backfillPlaceholders({ write: flags.includes('--write') });

  console.log(`found=${found} flagged=${flagged}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
