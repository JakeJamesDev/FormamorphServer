#!/usr/bin/env node

/**
 * Usage:
 *   npm run backfill-download-days -- <backup> <backup> ...            Count what would be added
 *   npm run backfill-download-days -- --write <backup> <backup> ...    Add it, once
 *
 * Backups go in time order, the deploy's pre-deploy backup last.
 */

require('../config/loadEnv');
const { backfillDownloadDays } = require('./backfillDownloadDays');

const args = process.argv.slice(2);
const flags = args.filter((arg) => arg.startsWith('--'));
const files = args.filter((arg) => !arg.startsWith('--'));
const unknown = flags.filter((flag) => flag !== '--write');

if (unknown.length > 0) {
  console.error(`Unknown flag: ${unknown.join(' ')}`);
  process.exit(1);
}

try {
  const write = flags.includes('--write');
  const { worlds, buckets, downloads, skipped, picks } = backfillDownloadDays(files, { write });

  console.log(`worlds=${worlds} buckets=${buckets} downloads=${downloads} skipped=${skipped}`);
  if (write) console.log(`picks=${picks.join(',') || 'none'}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
