const AccountToken = require('../models/AccountToken');
const { sendMail } = require('./mail');
const { SITE_URL } = require('../config/mail');
const { VERIFY, RESET } = require('../config/accountTokens');

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

/** The site's light-theme primary green. */
const BUTTON_COLOR = '#3a7e41';

/**
 * One account mail as HTML: a lead line, a button, a note, then the raw link as a labeled fallback.
 *
 * Inline styles and a table button, because mail clients drop `<style>` blocks and pad `<a>` unevenly.
 *
 * @param {Object} parts - What the mail says
 * @param {string} parts.lead - The sentence above the button
 * @param {string} parts.label - The button text
 * @param {string} parts.link - Where the button goes
 * @param {string} parts.note - The sentence under the button
 * @returns {string} The HTML body
 */
const accountMailHtml = ({ lead, label, link, note }) => {
  const href = escapeHtml(link);

  return [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;max-width:520px;">',
    `<p style="margin:0 0 20px;">${escapeHtml(lead)}</p>`,
    '<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px;"><tr>',
    `<td style="border-radius:6px;background:${BUTTON_COLOR};">`,
    `<a href="${href}" style="display:inline-block;padding:12px 22px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a>`,
    '</td></tr></table>',
    `<p style="margin:0 0 24px;">${escapeHtml(note)}</p>`,
    '<hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 16px;">',
    '<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">Button not working? Paste this link into your browser:</p>',
    `<p style="margin:0;font-size:13px;color:#6b7280;word-break:break-all;"><a href="${href}" style="color:#6b7280;">${href}</a></p>`,
    '</div>'
  ].join('\n');
};

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
  const lead = 'Confirm this address so it can recover your account.';
  const note = "The link works once. If you didn't ask for it, ignore this mail.";

  await sendMail({
    to: email,
    subject: 'Verify your Formamorph email address',
    text: [lead, '', link, '', note].join('\n'),
    html: accountMailHtml({ lead, label: 'Verify My Email Address', link, note })
  });
};

/**
 * Mint a reset link for an account and mail it to the verified address on file.
 *
 * Only a caller that has checked the address is verified may call this. An unproven address is somebody
 * else's until it is proven, and mailing a reset link to it hands them the account.
 *
 * @param {Object} params - Who to write to
 * @param {string} params.userId - The account the link resets
 * @param {string} params.email - The verified address, which is where the link goes
 * @returns {Promise<void>} Resolves when the transport has taken the message
 */
const sendPasswordResetEmail = async ({ userId, email }) => {
  const token = AccountToken.issue({ userId, purpose: RESET });
  const link = `${SITE_URL}/reset-password?token=${encodeURIComponent(token)}`;
  const lead = 'Set a new password for your account.';
  const note = "The link works once and expires in an hour. If you didn't ask for it, ignore this mail. Your password stays as it is.";

  await sendMail({
    to: email,
    subject: 'Reset your Formamorph password',
    text: [lead, '', link, '', note].join('\n'),
    html: accountMailHtml({ lead, label: 'Set a New Password', link, note })
  });
};

module.exports = { sendVerificationEmail, sendPasswordResetEmail };
