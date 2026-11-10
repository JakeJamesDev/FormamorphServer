const crypto = require('crypto');
const {
  SESv2Client, SendEmailCommand, GetAccountCommand, DeleteSuppressedDestinationCommand
} = require('@aws-sdk/client-sesv2');
const { MAIL_FROM, MAIL_REPLY_TO, MAIL_ID_TAG, MAIL_KIND_TAG } = require('../config/mail');
const MailLog = require('../models/MailLog');

/**
 * The one way this server sends mail, and the seam a test replaces.
 *
 * A transport is any object with `send({ from, replyTo, to, subject, text, html, tags })` resolving to
 * `{ messageId }`. Which one the process uses is decided once, here, from the environment: every SES key
 * means Amazon SES, a missing one means refusal. Callers never choose, so nothing can reach AWS from a test
 * or a development box by mistake.
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
 * @returns {{ sendEmail: (input: Object) => Promise<Object>, getAccount: () => Promise<Object>,
 *   deleteSuppressedDestination: (input: Object) => Promise<Object> }} An SES client
 */
const sesClient = ({ accessKeyId, secretAccessKey, region }) => {
  const client = new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } });

  return {
    sendEmail: (input) => client.send(new SendEmailCommand(input)),
    getAccount: () => client.send(new GetAccountCommand({})),
    deleteSuppressedDestination: (input) => client.send(new DeleteSuppressedDestinationCommand(input))
  };
};

/** SES quotes refused identities in its messages; a log line must not carry an address. */
const withoutAddresses = (text) => String(text || '').replace(/[^\s<>"',;:()]+@[^\s<>"',;:()]+/g, '<address>');

/** A new error without `cause`, so a logged SES failure holds no recipient. */
const sesError = (what, error) => {
  const requestId = error.$metadata?.requestId ? ` [request ${error.$metadata.requestId}]` : '';
  return new Error(`${what} (${error.name || 'Error'})${requestId}: ${withoutAddresses(error.message)}`);
};

/**
 * Amazon SES, through the v2 SendEmail call.
 *
 * @param {{ sendEmail: (input: Object) => Promise<Object> }} client - From `sesClient`, or a test's fake
 * @param {string} configurationSetName - The SES configuration set every mail is sent with
 * @returns {{send: (message: Object) => Promise<{messageId: string|null}>}} A transport
 */
const sesTransport = (client, configurationSetName) => ({
  send: async ({ from, replyTo, to, subject, text, html, tags = {} }) => {
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
    const emailTags = Object.entries(tags).map(([Name, Value]) => ({ Name, Value }));
    if (emailTags.length) input.EmailTags = emailTags;

    let response;
    try {
      response = await client.sendEmail(input);
    } catch (error) {
      throw sesError('SES refused the message', error);
    }

    return { messageId: response?.MessageId ?? null };
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
 * @returns {{messages: Object[], send: (message: Object) => Promise<{messageId: string}>}} A transport with its record
 */
const captureTransport = () => {
  const messages = [];

  return {
    messages,
    send: async (message) => {
      messages.push(message);
      return { messageId: `captured-${messages.length}` };
    }
  };
};

/**
 * Choose the transport an environment gets.
 *
 * @param {Object} env - Usually `process.env`
 * @param {Function} [makeClient] - Builds the SES client; tests pass a fake
 * @returns {{ transport: Object, client: Object|null, missing: string[] }} The transport, the SES client (null
 *   when mail is off), and the keys whose absence turned mail off
 */
const transportFromEnv = (env, makeClient = sesClient) => {
  const missing = REQUIRED_MAIL_KEYS.filter((key) => !env[key]);
  if (missing.length) return { transport: mailOffTransport(missing), client: null, missing };

  const client = makeClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_REGION || DEFAULT_SES_REGION
  });

  return { transport: sesTransport(client, env.SES_CONFIGURATION_SET), client, missing };
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

let client = startup.client;

/** Put an SES client in place of the one chosen at startup. Tests only. */
const setSesClient = (replacement) => { client = replacement; };

/** Put the startup SES client back. */
const resetSesClient = () => { client = startup.client; };

/**
 * Read the SES account's standing and sending quota.
 *
 * @returns {Promise<{ enforcementStatus: string|null, sendingEnabled: boolean|null, sentLast24Hours: number|null,
 *   max24HourSend: number|null }|null>} The account, or null when mail is off
 */
const readSesAccount = async () => {
  if (!client) return null;
  let account;
  try {
    account = await client.getAccount();
  } catch (error) {
    throw sesError('SES account read failed', error);
  }

  return {
    enforcementStatus: account?.EnforcementStatus ?? null,
    sendingEnabled: account?.SendingEnabled ?? null,
    sentLast24Hours: account?.SendQuota?.SentLast24Hours ?? null,
    max24HourSend: account?.SendQuota?.Max24HourSend ?? null
  };
};

/**
 * Take an address off the SES account suppression list.
 *
 * An address that was not on the list is already off it. With mail off there is no list.
 *
 * @param {string} address - The address to remove
 * @returns {Promise<void>} Resolves when the address is off the list
 * @throws {Error} Without the address in its message, when SES refuses
 */
const removeFromSuppressionList = async (address) => {
  if (!client) return;
  try {
    await client.deleteSuppressedDestination({ EmailAddress: address });
  } catch (error) {
    if (error.name === 'NotFoundException') return;
    throw sesError('SES suppression removal failed', error);
  }
};

/**
 * Send one message and log it once SES has taken it.
 *
 * The log row's id is the mail's tag, so an SES event finds its row without the address. A refused send
 * throws before the row is written.
 *
 * @param {Object} message - `{ to, subject, text, html, userId, kind }`; the sender is this server's.
 *   `userId` is null for staff alert mail; `kind` is one of `MailLog.KINDS`
 * @returns {Promise<void>} Resolves when the transport has taken it
 */
const sendMail = async ({ to, subject, text, html, userId, kind }) => {
  if (!MailLog.KINDS.includes(kind)) throw new Error(`Unknown mail kind: ${kind}`);
  const id = crypto.randomUUID();
  // A UUID and a known kind: only the letters, digits, dashes and underscores SES allows in a tag.
  const tags = { [MAIL_ID_TAG]: id, [MAIL_KIND_TAG]: kind };

  const sent = await transport.send({ from: MAIL_FROM, replyTo: MAIL_REPLY_TO, to, subject, text, html, tags });

  // The mail is out, so a failed write must not make the caller report it as unsent.
  try {
    MailLog.create({ id, userId: userId ?? null, kind, messageId: sent?.messageId ?? null });
  } catch (error) {
    console.error('Mail log write failed:', error.message);
  }
};

module.exports = {
  sendMail,
  setMailTransport,
  resetMailTransport,
  setSesClient,
  resetSesClient,
  readSesAccount,
  removeFromSuppressionList,
  captureTransport,
  sesTransport,
  transportFromEnv,
  missingMailKeys,
  mailEnabled
};
