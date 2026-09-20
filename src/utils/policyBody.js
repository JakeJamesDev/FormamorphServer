const fs = require('fs');
const path = require('path');

/** The authored text, read from disk so the owner and a lawyer edit markdown rather than a string literal. */
const PRIVACY_BODY_FILE = path.join(__dirname, '..', 'assets', 'policies', 'privacy-policy.md');

/**
 * Read the authored Privacy Policy.
 *
 * Line endings are normalized because the repo checks out CRLF on Windows, and the stored body should not
 * depend on which machine wrote it. Opens no database, so a schema step may use it.
 *
 * @param {string} [file] - The markdown file to read
 * @returns {string} The body as it is stored
 */
const readPrivacyBody = (file = PRIVACY_BODY_FILE) =>
  fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim();

module.exports = { PRIVACY_BODY_FILE, readPrivacyBody };
