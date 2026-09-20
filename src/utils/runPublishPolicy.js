#!/usr/bin/env node

/**
 * Usage:
 *   npm run publish-policy                       Show what would change
 *   npm run publish-policy -- --write            Store the authored body
 *   npm run publish-policy -- --write --reaccept Store it and ask everyone to accept again
 */

require('dotenv').config();
const { publishPrivacyPolicy } = require('./publishPolicy');

const flags = process.argv.slice(2);
const unknown = flags.filter((flag) => !['--write', '--reaccept'].includes(flag));

if (unknown.length > 0) {
  console.error(`Unknown flag: ${unknown.join(' ')}`);
  process.exit(1);
}

try {
  const result = publishPrivacyPolicy({
    write: flags.includes('--write'),
    requireReaccept: flags.includes('--reaccept')
  });

  result.diff.forEach((line) => console.log(line));
  console.log(`${result.status} acceptance_version=${result.version}`);

  // A re-accept that did not happen must not look like one that did.
  process.exit(result.status === 'unchanged' && flags.includes('--reaccept') ? 1 : 0);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
