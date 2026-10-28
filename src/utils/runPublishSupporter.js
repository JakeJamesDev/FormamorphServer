#!/usr/bin/env node

/**
 * Usage:
 *   npm run publish-supporter -- <mascot.webp> --author <staff username> [--name <name>] [--thumbnail <image>] [--description <text>]
 *     Publish a Mascot tab export as a Supporter-only, pinned listing
 */

require('dotenv').config();
const fs = require('fs');
const { publishSupporter } = require('./publishSupporter');

const USAGE = 'Usage: npm run publish-supporter -- <mascot.webp> --author <staff username> [--name <name>] [--thumbnail <image>] [--description <text>]';
const FLAGS = new Set(['--author', '--name', '--thumbnail', '--description']);

function parseArgs(args) {
  const options = {};
  const files = [];
  for (let i = 0; i < args.length; i += 1) {
    if (FLAGS.has(args[i]) && i + 1 < args.length) {
      options[args[i].slice(2)] = args[i + 1];
      i += 1;
    } else if (args[i].startsWith('--')) {
      return null;
    } else {
      files.push(args[i]);
    }
  }
  return files.length === 1 && options.author ? { file: files[0], ...options } : null;
}

const parsed = parseArgs(process.argv.slice(2));
if (!parsed) {
  console.error(USAGE);
  process.exit(1);
}

Promise.resolve()
  .then(() => publishSupporter({
    card: fs.readFileSync(parsed.file),
    thumbnail: parsed.thumbnail ? fs.readFileSync(parsed.thumbnail) : undefined,
    author: parsed.author,
    name: parsed.name,
    description: parsed.description
  }))
  .then((row) => console.log(`Published "${row.name}" (${row.id}): Supporter-only, pinned.`))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
