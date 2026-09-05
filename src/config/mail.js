/**
 * Where mail comes from and where its links point.
 *
 * Both are environment values with a default, because a development box has no Resend key and still has
 * to build a link somebody can read. `RESEND_API_KEY` is deliberately not re-exported: the transport is
 * the only thing that ever needs it, and a key that reaches nothing else cannot be logged by accident.
 */

/** The sender Resend is configured to sign for. A mail from any other address is refused by the API. */
const MAIL_FROM = process.env.MAIL_FROM || 'noreply@formamorph.ai';

/** The site the links open. Trailing slash trimmed, so a link is never built with two. */
const SITE_URL = (process.env.SITE_URL || 'https://formamorph.ai').replace(/\/+$/, '');

module.exports = { MAIL_FROM, SITE_URL };
