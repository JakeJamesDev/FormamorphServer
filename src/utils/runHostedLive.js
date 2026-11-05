#!/usr/bin/env node

/**
 * Usage:
 *   npm run live:hosted-ai
 *   npm run live:hosted-ai -- --prompt "Describe a tavern." --max-tokens 400 --mode stream
 *
 * Flags:
 *   --prompt TEXT     The user message                              (default: a short greeting)
 *   --max-tokens N    The call's max_tokens                         (default 200)
 *   --body FILE       A full chat completion as JSON, instead of --prompt and --max-tokens
 *   --mode MODE       stream, whole or both                         (default both)
 *   --tier TIER       The account's tier                            (default supporter)
 *   --settings FILE   The hosted_ai copy                            (default .scratch/hosted-ai-settings.json)
 *
 * Sends real calls on HOSTED_AI_TEST_API_KEY through the real app, with a scratch in-memory database.
 * Exits 1 when a call fails or a row or parallel slot leaks.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '../..');
const envFile = path.join(ROOT, '.env');
// Parsed, not loaded, so the run's process holds no other local secret.
const localEnv = fs.existsSync(envFile) ? dotenv.parse(fs.readFileSync(envFile)) : {};

// Before anything reads `config/paths` or `config/db`.
process.env.DB_PATH = ':memory:';
process.env.STORAGE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fms-live-'));
process.env.JWT_SECRET = crypto.randomBytes(16).toString('hex');
process.env.SIGNAL_SALT ||= 'live-run-salt';
process.env.NODE_ENV = 'test';
delete process.env.RESEND_API_KEY;
delete process.env.STAFF_ALERT_EMAIL;

const MODES = { stream: ['stream'], whole: ['whole'], both: ['stream', 'whole'] };

const parse = (argv) => {
  const options = {
    prompt: 'Say hello in one short sentence.',
    maxTokens: 200,
    body: null,
    mode: 'both',
    tier: undefined,
    settings: path.join(ROOT, '.scratch', 'hosted-ai-settings.json')
  };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--prompt') options.prompt = value;
    else if (flag === '--body') options.body = value;
    else if (flag === '--tier') options.tier = value;
    else if (flag === '--settings') options.settings = value;
    else if (flag === '--mode') {
      if (!MODES[value]) throw new Error('--mode is stream, whole or both');
      options.mode = value;
    } else if (flag === '--max-tokens') {
      options.maxTokens = Number(value);
      if (!Number.isInteger(options.maxTokens) || options.maxTokens < 1) throw new Error('--max-tokens needs a whole number');
    } else {
      throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return options;
};

const rowLine = (row) => [
  `status ${row.status}`,
  `model ${row.model}`,
  `tokens ${row.prompt_tokens}+${row.output_tokens}`,
  `$${(row.cost_micros / 1_000_000).toFixed(6)} (${row.cost_source})`,
  `first token ${row.first_token_ms} ms`,
  `finish ${row.finish_reason}`,
  ...(row.failure ? [`failure ${row.failure}`] : [])
].join(', ');

(async () => {
  try {
    const { readLiveEnv, readLiveSettings, runLive } = require('./hostedLive');
    const options = parse(process.argv.slice(2));
    const { upstreamUrl, apiKey } = readLiveEnv({ ...localEnv, ...process.env });
    const settings = readLiveSettings(options.settings);
    const requestBody = options.body
      ? JSON.parse(fs.readFileSync(options.body, 'utf8'))
      : { messages: [{ role: 'user', content: options.prompt }], max_tokens: options.maxTokens };

    // The app logs one line per request, which would interleave with the replies.
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    let report;
    try {
      report = await runLive({ settings, upstreamUrl, apiKey, requestBody, modes: MODES[options.mode], tier: options.tier });
    } finally {
      process.stdout.write = write;
    }

    for (const call of report.calls) {
      console.log(`${call.mode}: HTTP ${call.status} in ${call.ms.toFixed(0)} ms${call.code ? `, ${call.code}` : ''}`);
      if (call.thinkingChars) console.log(`  Thinking: ${call.thinkingChars} characters`);
      if (call.reply) console.log(`  Reply: ${call.reply}`);
      if (call.usage) console.log(`  Usage: ${JSON.stringify(call.usage)}`);
      for (const row of call.rows) console.log(`  Row: ${rowLine(row)}`);
    }
    console.log(`Rows left open: ${report.openRows}`);
    console.log(`Parallel slots held: ${report.slots}`);
    console.log(report.ok ? 'PASS' : 'FAIL');
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
})();
