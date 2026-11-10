const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const { MAIL_FROM, MAIL_REPLY_TO } = require('../config/mail');

/**
 * The one way this server sends mail, and the seam a test replaces.
 *
 * A transport is any object with `send({ from, replyTo, to, subject, text, html })` returning a promise. Which one
 * the process uses is decided once, here, from the environment: every SES key means Amazon SES, a missing one
 * means refusal. Callers never choose, so nothing can reach AWS from a test or a development box by mistake.
 */

/** The region where this account has SES production access. */
const DEFAULT_SES_REGION = 'us-east-2';

/** Keys without which no mail goes out. The configuration set is one: a mail sent without it is untracked. */
const REQUIRED_MAIL_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SES_CONFIGURATION_SET'];

const UTF8 = 'UTF-8';

/**
 * The one object that talks to AWS. Tests replace it with a fake.
 *
 * Credentials are passed in rather than left to the SDK's default chain, so a profile on a development box
 * never sends mail.
 *
 * @param {{ accessKeyId: string, secretAccessKey: string, region: string }} settings - From the environment
 * @returns {{ sendEmail: (input: Object) => Promise<Object> }} An SES client
 */
const sesClient = ({ accessKeyId, secretAccessKey, region }) => {
  const client = new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } });

  return { sendEmail: (input) => client.send(new SendEmailCommand(input)) };
};

/** SES quotes refused identities in its messages; a log line must not carry an address. */
const withoutAddresses = (text) => String(text || '').replace(/[^\s<>"',;:()]+@[^\s<>"',;:()]+/g, '<address>');

/**
 * Amazon SES, through the v2 SendEmail call.
 *
 * @param {{ sendEmail: (input: Object) => Promise<Object> }} client - From `sesClient`, or a test's fake
 * @param {string} configurationSetName - The SES configuration set every mail is sent with
 * @returns {{send: (message: Object) => Promise<void>}} A transport
 */
const sesTransport = (client, configurationSetName) => ({
  send: async ({ from, replyTo, to, subject, text, html }) => {
    const body = {};
    if (text !== undefined) body.Text = { Data: text, Charset: UTF8 };
    if (html !== undefined) body.Html = { Data: html, Charset: UTF8 };

    const input = {
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: subject, Charset: UTF8 }, Body: body } },
      ConfigurationSetName: configurationSetName
    };
    if (replyTo) input.ReplyToAddresses = [replyTo];

    try {
      await client.sendEmail(input);
    } catch (error) {
      // A new error without `cause`, so a logged failure holds no recipient.
      const requestId = error.$metadata?.requestId ? ` [request ${error.$metadata.requestId}]` : '';
      throw new Error(`SES refused the message (${error.name || 'Error'})${requestId}: ${withoutAddresses(error.message)}`);
    }
  }
});

/**
 * What a box without every key does: refuse every message, so callers report it as not sent.
 *
 * A developer who needs the link reads it out of the database or runs with the keys.
 *
 * @param {string[]} missing - The unset keys, named in the refusal
 * @returns {{send: (message: Object) => Promise<void>}} A transport
 */
const mailOffTransport = (missing) => ({
  send: async () => {
    throw new Error(`Mail is off: ${missing.join(', ')} unset`);
  }
});

/**
 * Keeps every message instead of sending it, for tests to assert on.
 *
 * @returns {{messages: Object[], send: (message: Object) => Promise<void>}} A transport with its record
 */
const captureTransport = () => {
  const messages = [];

  return { messages, send: async (message) => { messages.push(message); } };
};

/**
 * Choose the transport an environment gets.
 *
 * @param {Object} env - Usually `process.env`
 * @param {Function} [makeClient] - Builds the SES client; tests pass a fake
 * @returns {{ transport: Object, missing: string[] }} The transport, and the keys whose absence turned mail off
 */
const transportFromEnv = (env, makeClient = sesClient) => {
  const missing = REQUIRED_MAIL_KEYS.filter((key) => !env[key]);
  if (missing.length) return { transport: mailOffTransport(missing), missing };

  const client = makeClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_REGION || DEFAULT_SES_REGION
  });

  return { transport: sesTransport(client, env.SES_CONFIGURATION_SET), missing };
};

/** Chosen once, at load, from the environment. */
const startup = transportFromEnv(process.env);

/** The keys whose absence keeps this process from sending real mail; empty when mail is on. */
const missingMailKeys = startup.missing;

/** Whether this process can send real mail. */
const mailEnabled = missingMailKeys.length === 0;

let transport = startup.transport;

/** Put a transport in place of the one chosen at startup. Tests only. */
const setMailTransport = (replacement) => { transport = replacement; };

/** Put the startup transport back. */
const resetMailTransport = () => { transport = startup.transport; };

/**
 * Send one message.
 *
 * @param {Object} message - `{ to, subject, text, html }`; the sender is this server's, not a caller's
 * @returns {Promise<void>} Resolves when the transport has taken it
 */
const sendMail = ({ to, subject, text, html }) =>
  transport.send({ from: MAIL_FROM, replyTo: MAIL_REPLY_TO, to, subject, text, html });

module.exports = {
  sendMail,
  setMailTransport,
  resetMailTransport,
  captureTransport,
  sesTransport,
  transportFromEnv,
  missingMailKeys,
  mailEnabled
};
