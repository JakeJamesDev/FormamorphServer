const { MAIL_FROM } = require('../config/mail');

/**
 * The one way this server sends mail, and the seam a test replaces.
 *
 * A transport is any object with `send({ from, to, subject, text, html })` returning a promise. Which one
 * the process uses is decided once, here, from the environment: a key means Resend, no key means the log.
 * Callers never choose, so nothing can reach the real API from a test or a development box by mistake.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Resend's HTTP API.
 *
 * No SDK: one POST with a bearer key is the whole of it, and a dependency that wraps that is a
 * dependency to keep up to date. A non-2xx answer throws with Resend's own body, which is the only place
 * the reason for a refusal is written.
 *
 * @param {string} apiKey - The account key, from `RESEND_API_KEY`
 * @returns {{send: (message: Object) => Promise<void>}} A transport
 */
const resendTransport = (apiKey) => ({
  send: async ({ from, to, subject, text, html }) => {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text, html })
    });

    if (!response.ok) {
      throw new Error(`Resend refused the message (${response.status}): ${await response.text()}`);
    }
  }
});

/**
 * What a box with no key does: print the subject and the recipient, and drop the body.
 *
 * The link is in the body, so this is not a way to read one — a developer who needs the link reads it out
 * of the database or runs with a key. What it is for is the line in the journal saying mail was reached.
 *
 * @returns {{send: (message: Object) => Promise<void>}} A transport
 */
const logTransport = () => ({
  send: async ({ to, subject }) => {
    console.log(`Mail (no RESEND_API_KEY, not sent): "${subject}" to ${to}`);
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

/** Chosen once, at load, from the environment. */
const startupTransport = process.env.RESEND_API_KEY
  ? resendTransport(process.env.RESEND_API_KEY)
  : logTransport();

let transport = startupTransport;

/** Put a transport in place of the one chosen at startup. Tests only. */
const setMailTransport = (replacement) => { transport = replacement; };

/** Put the startup transport back. */
const resetMailTransport = () => { transport = startupTransport; };

/**
 * Send one message.
 *
 * @param {Object} message - `{ to, subject, text, html }`; the sender is this server's, not a caller's
 * @returns {Promise<void>} Resolves when the transport has taken it
 */
const sendMail = ({ to, subject, text, html }) =>
  transport.send({ from: MAIL_FROM, to, subject, text, html });

module.exports = { sendMail, setMailTransport, resetMailTransport, captureTransport };
