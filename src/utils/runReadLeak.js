#!/usr/bin/env node

/**
 * Usage:
 *   npm run read-leak -- <image file>   Print the account a leaked image was marked for
 */

require('dotenv').config();
const { readLeak, describeLeak } = require('./readLeak');

const args = process.argv.slice(2);

if (args.length !== 1) {
  console.error('Usage: npm run read-leak -- <image file>');
  process.exit(1);
}

readLeak(args[0])
  .then((result) => console.log(describeLeak(result)))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
