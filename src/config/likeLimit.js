/**
 * The budget both like routes share.
 *
 * The global limiter is a thousand requests per address per window, which a script pointed at the heart
 * would sit comfortably inside while adding a mark a second. Liking is a press: a person who gives sixty
 * of them in a quarter of an hour is reading fast, and nobody reaches this by using the app.
 *
 * Keyed on the client address rather than the account, because the guest route has no account to key on
 * and one budget over both routes is the point — signing out must not hand anybody a second allowance.
 *
 * Its own module so the routes and the tests name one number.
 */

const LIKE_WINDOW_MS = 15 * 60 * 1000;
const LIKE_LIMIT = 120;

module.exports = { LIKE_WINDOW_MS, LIKE_LIMIT };
