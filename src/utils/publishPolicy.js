const Policy = require('../models/Policy');
const { BODY_MAX, PRIVACY_POLICY } = require('../config/policies');
const { readPrivacyBody } = require('./policyBody');

/**
 * A line diff, longest common subsequence. The policy is about a hundred lines, so the table is small.
 *
 * @param {string} before - The stored body
 * @param {string} after - The authored body
 * @returns {Array<string>} Changed lines only, each prefixed `-` or `+`, in reading order
 */
const diffLines = (before, after) => {
  const a = before.split('\n');
  const b = after.split('\n');
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      lines.push(`-${a[i++]}`);
    } else {
      lines.push(`+${b[j++]}`);
    }
  }

  return lines;
};

/**
 * Put the authored Privacy Policy into the live row.
 *
 * Only the body moves. Title, tags, and the enabled switch belong to the Policies tab and stay as the owner
 * left them. A dry run is the default, so an edit made in that tab shows in the diff before it is replaced.
 *
 * @param {Object} [options]
 * @param {boolean} [options.write] - Store the body; without it, only report the diff
 * @param {boolean} [options.requireReaccept] - Bump the acceptance version with the write
 * @param {string} [options.body] - The authored body; read from disk by default
 * @returns {{ status: string, diff: Array<string>, version: number }} `unchanged`, `pending`, or `published`
 */
const publishPrivacyPolicy = ({ write = false, requireReaccept = false, body = readPrivacyBody() } = {}) => {
  const row = Policy.findById(PRIVACY_POLICY);
  if (!row) throw new Error('The privacy policy row is absent');

  if (body.length > BODY_MAX[PRIVACY_POLICY]) {
    throw new Error(`Body is ${body.length} characters; the limit is ${BODY_MAX[PRIVACY_POLICY]}`);
  }

  // An unchanged body never bumps the version, so a repeated run cannot ask everyone twice.
  if (row.body === body) return { status: 'unchanged', diff: [], version: row.acceptance_version };

  const diff = diffLines(row.body, body);
  if (!write) return { status: 'pending', diff, version: row.acceptance_version };

  const saved = Policy.save(
    PRIVACY_POLICY,
    { enabled: row.enabled, title: row.title, body, tags: row.tags },
    requireReaccept
  );

  return { status: 'published', diff, version: saved.acceptance_version };
};

module.exports = { diffLines, publishPrivacyPolicy };
