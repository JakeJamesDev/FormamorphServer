#!/usr/bin/env node

/**
 * Usage:
 *   npm run load:hosted-ai
 *   npm run load:hosted-ai -- --accounts 20 --parallel 4 --turns 5 --delay-ms 800
 *
 * Flags:
 *   --accounts N        Entitled accounts running at once            (default 10)
 *   --turns N           Turns per account, one after another          (default 3)
 *   --parallel N        Calls per turn: one first call, then N-1 at once (default 4)
 *   --delay-ms N        Silence from the fake upstream before its first byte (default 500)
 *   --parallel-limit N  Per-account parallel limit                    (default: --parallel)
 *   --minute-limit N    Per-account calls per minute                  (default: enough for the run)
 *   --expect a,b        Refusal codes the run is meant to trigger; any other failure fails the run
 *
 * Runs the real app against a scratch in-memory database and a fake upstream. It never reads the real
 * database or the upstream key, so it is safe to run on the production host. Exits 1 when a row is left
 * open, a parallel slot is left held, or a call fails in a way `--expect` does not name.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Before anything reads `config/paths` or `config/db`: a scratch database, scratch storage, no `.env`.
process.env.DB_PATH = ':memory:';
process.env.STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fms-load-'));
process.env.JWT_SECRET = crypto.randomBytes(16).toString('hex');
process.env.SIGNAL_SALT ||= 'load-run-salt';
process.env.NODE_ENV = 'test';

const NUMBER_FLAGS = {
  '--accounts': 'accounts', '--turns': 'turns', '--parallel': 'parallel', '--delay-ms': 'delayMs',
  '--parallel-limit': 'parallelLimit', '--minute-limit': 'minuteLimit'
};

const parse = (argv) => {
  const options = { accounts: 10, turns: 3, parallel: 4, delayMs: 500, expect: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--expect') {
      options.expect = (value || '').split(',').filter(Boolean);
    } else if (NUMBER_FLAGS[flag]) {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 0 || (flag !== '--delay-ms' && number < 1)) throw new Error(`${flag} needs a whole number`);
      options[NUMBER_FLAGS[flag]] = number;
    } else {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return options;
};

const ms = (value) => (value === null ? 'n/a' : `${value.toFixed(0)} ms`);

(async () => {
  try {
    const { runLoad } = require('./hostedLoad');
    const options = parse(process.argv.slice(2));
    // The app logs one line per request; hundreds of them would bury the report.
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    let report;
    try {
      report = await runLoad(options);
    } finally {
      process.stdout.write = write;
    }

    console.log(`Calls: ${report.calls} (${report.rows} admitted) in ${ms(report.wallMs)}`);
    console.log(`Time to first byte: p50 ${ms(report.ttfbP50Ms)}, p90 ${ms(report.ttfbP90Ms)}`);
    console.log(`Failures: ${Object.keys(report.failures).length ? JSON.stringify(report.failures) : 'none'}`);
    console.log(`Rows left open: ${report.openRows}`);
    console.log(`Parallel slots held: ${report.slots}`);
    if (report.unplanned.length) console.log(`Unplanned: ${report.unplanned.join(', ')}`);
    console.log(report.ok ? 'PASS' : 'FAIL');
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
})();
