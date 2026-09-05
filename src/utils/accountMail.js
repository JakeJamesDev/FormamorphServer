const AccountToken = require('../models/AccountToken');
const { sendMail } = require('./mail');
const { SITE_URL } = require('../config/mail');
const { VERIFY } = require('../config/accountTokens');

/**
 * The account mails this server sends, written once so every caller sends the same thing.
 *
 * Minting the token and mailing it belong together: a token nobody was sent is a row that can only ever
 * expire, and a mail with no token in it is a dead end. So each function here does both, and a caller
 * that only wants one of the two has asked for the wrong thing.
 */

/** HTML is a courtesy; the text part is the message. Both carry the same link so either client works. */
const escapeHtml = (value) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Mint a verification link for an account and mail it to the address on file.
 *
 * @param {Object} params - Who to write to
 * @param {string} params.userId - The account whose address is being verified
 * @param {string} params.email - The address, which is where the link goes
 * @returns {Promise<void>} Resolves when the transport has taken the message
 */
const sendVerificationEmail = async ({ userId, email }) => {
  const token = AccountToken.issue({ userId, purpose: VERIFY });
  const link = `${SITE_URL}/verify-email?token=${encodeURIComponent(token)}`;

  await sendMail({
    to: email,
    subject: 'Verify your Formamorph email address',
    text: [
      'Confirm this address so it can recover your account:',
      '',
      link,
      '',
      'The link works once. If you did not ask for it, nothing happens when you ignore it.'
    ].join('\n'),
    html: [
      '<p>Confirm this address so it can recover your account:</p>',
      `<p><a href="${escapeHtml(link)}">Verify my email address</a></p>`,
      `<p>${escapeHtml(link)}</p>`,
      '<p>The link works once. If you did not ask for it, nothing happens when you ignore it.</p>'
    ].join('\n')
  });
};

module.exports = { sendVerificationEmail };
