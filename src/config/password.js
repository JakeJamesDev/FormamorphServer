/**
 * The one rule a password has to clear, wherever it is set.
 *
 * Two routes write passwords: change-password proves the old one, reset-password proves a mailed token.
 * They are meant to apply the same rule, and the only way that stays true is for there to be one rule to
 * apply — a number spelled in both places stops matching the first time either moves.
 */

const PASSWORD_MIN_LENGTH = 6;

/** Worded as the client already shows it, so tightening the rule updates the message with it. */
const PASSWORD_RULE = `New password must be at least ${PASSWORD_MIN_LENGTH} characters long`;

module.exports = { PASSWORD_MIN_LENGTH, PASSWORD_RULE };
