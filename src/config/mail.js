/**
 * Where mail comes from, where its links point, and how much of it one account may ask for.
 *
 * The sender and the site are environment values with a default, because a development box has no Resend
 * key and still has to build a link somebody can read. `RESEND_API_KEY` is deliberately not re-exported:
 * the transport is the only thing that ever needs it, and a key that reaches nothing else cannot be
 * logged by accident.
 */

const { HOUR_MS } = require('./time');

/** The sender Resend is configured to sign for. A mail from any other address is refused by the API. */
const MAIL_FROM = process.env.MAIL_FROM || 'noreply@formamorph.ai';

/** The site the links open. Trailing slash trimmed, so a link is never built with two. */
const SITE_URL = (process.env.SITE_URL || 'https://formamorph.ai').replace(/\/+$/, '');

/**
 * How much verification mail one account may cause, and over what window.
 *
 * An inbox is protected by bounding the account rather than the address, because an address can only be
 * mailed by the one account holding it — the unique index sees to that — so a budget on the account is
 * already a budget on the inbox. Keying on the address instead would let anyone spend a stranger's
 * budget by repeatedly trying to claim their address, which is the opposite of the point.
 *
 * Five is what somebody who genuinely lost the mail needs, and far short of what burying an inbox takes.
 * Held in the limiter's memory store and nowhere else, so no address is written down to enforce it.
 */
const MAIL_LIMIT = 5;
const MAIL_WINDOW_MS = HOUR_MS;

module.exports = { MAIL_FROM, SITE_URL, MAIL_LIMIT, MAIL_WINDOW_MS };
