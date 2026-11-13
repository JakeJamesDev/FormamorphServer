// From a shell the database path comes from `.env`, and it must load before the db module opens a file.
if (require.main === module) require('dotenv').config();

const db = require('../config/db');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');
const { PLACEHOLDER_ID } = require('../config/accountDeletion');
const { deleteAvatar } = require('./fileStorage');
const { clearAccountCache } = require('./supporterProcessing');

/**
 * What happens to each column that points at the old account. Every foreign key to `users` must be named
 * here: an unnamed one stops the merge before it changes anything, so a new table cannot be left behind.
 *
 * `move` repoints the row and drops it where the kept account already has the same one (a like, a follow).
 * `drop` leaves the row to go with the old account. `sole` moves the row only when the kept account has
 * none, and refuses the merge otherwise, because one of the two would be lost.
 */
const RULES = {
  'worlds.author_id': 'move',
  'comments.author_id': 'move',
  'messages.sender_id': 'move',
  'messages.recipient_id': 'move',
  'message_states.user_id': 'move',
  'policy_acceptances.user_id': 'move',
  'feedback.reporter_id': 'move',
  'feedback_comments.author_id': 'move',
  'feedback_reads.user_id': 'move',
  'feedback_votes.user_id': 'move',
  'feedback_mentions.user_id': 'move',
  'world_likes.user_id': 'move',
  'install_claims.user_id': 'move',
  'follows.follower_id': 'move',
  'follows.followed_id': 'move',
  'events.created_by': 'move',
  'reports.reporter_id': 'move',
  'reports.resolved_by': 'move',
  'signals.user_id': 'move',
  'hosted_grants.user_id': 'move',
  'hosted_grants.created_by': 'move',
  'mail_log.user_id': 'move',
  'account_tokens.user_id': 'drop',
  'patreon_pending_links.user_id': 'drop',
  'hosted_warning_acks.user_id': 'drop',
  'patreon_links.user_id': 'sole',
  // A leaked file carries this mark, so losing it loses who leaked it.
  'watermark_marks.user_id': 'sole'
};

/** Columns that hold an account id without a foreign key. Usage stays with whoever spent it. */
const LOOSE_COLUMNS = ['hosted_usage.user_id', 'hosted_refusals.user_id'];

/** Thrown inside the transaction to roll a dry run back. */
class DryRun extends Error {}

/** Every `table.column` with a foreign key to `users`, read from the live schema. */
const userForeignKeys = () => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  return tables.flatMap((table) => db.prepare(`PRAGMA foreign_key_list(${table})`).all()
    .filter((key) => key.table === 'users')
    .map((key) => `${table}.${key.from}`));
};

const tableExists = (name) =>
  Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

const count = (table, column, id) =>
  db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(id).n;

const mergeRows = db.transaction((from, into, dryRun) => {
  const keys = userForeignKeys();
  const unnamed = keys.filter((key) => !RULES[key]);
  if (unnamed.length) throw new Error(`No merge rule for: ${unnamed.join(', ')}`);

  for (const key of keys.filter((key) => RULES[key] === 'sole')) {
    const [table, column] = key.split('.');
    if (count(table, column, from.id) && count(table, column, into.id)) {
      throw new Error(`Both accounts have ${key}; one would be lost`);
    }
  }

  // Measured against what was already broken, so old damage elsewhere does not block a merge.
  const brokenBefore = db.prepare('PRAGMA foreign_key_check').all().length;
  const moved = {};
  const dropped = {};
  const repoint = (key) => {
    const [table, column] = key.split('.');
    const before = count(table, column, from.id);
    if (!before) return;
    const changed = db.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ?`)
      .run(into.id, from.id).changes;
    if (changed) moved[key] = changed;
    if (before - changed) dropped[key] = before - changed;
  };

  for (const key of keys) {
    if (RULES[key] === 'drop') {
      const [table, column] = key.split('.');
      const n = count(table, column, from.id);
      if (n) dropped[key] = n;
    } else {
      repoint(key);
    }
  }
  for (const key of LOOSE_COLUMNS) {
    if (tableExists(key.split('.')[0])) repoint(key);
  }

  // What the merge made pointless: following yourself, and liking your own listing, which the like route refuses.
  const selfFollows = db.prepare('DELETE FROM follows WHERE follower_id = ? AND followed_id = ?')
    .run(into.id, into.id).changes;
  const selfLikes = db.prepare(`
    DELETE FROM world_likes WHERE user_id = @into AND world_id IN (SELECT id FROM worlds WHERE author_id = @into)
  `).run({ into: into.id }).changes;

  // A podium stores the name rather than joining it.
  const placements = db.prepare('UPDATE event_placements SET author_name = ? WHERE author_name = ?')
    .run(into.username, from.username).changes;

  // Last, so the rows left on the old account are only the ones this merge meant to drop.
  db.prepare('DELETE FROM users WHERE id = ?').run(from.id);

  const broken = db.prepare('PRAGMA foreign_key_check').all().length - brokenBefore;
  if (broken > 0) throw new Error(`Merge left ${broken} broken references`);

  const result = { moved, dropped, selfFollows, selfLikes, placements };
  if (dryRun) throw Object.assign(new DryRun(), { result });
  return result;
});

/**
 * Fold one account into another: its listings, comments, likes, follows and history move to the kept
 * account, and the old account is erased.
 *
 * A dry run does every row change inside the transaction and rolls it back, so its report is exactly what
 * a real run would do against the same data.
 *
 * @param {string} fromName - The account that goes away
 * @param {string} intoName - The account that stays
 * @param {Object} [options]
 *   `dryRun` — report the merge and change nothing (default true)
 * @returns {Promise<Object>} `{ from, into, dryRun, moved, dropped, selfFollows, selfLikes, placements }`
 * @throws {Error} When either account is missing, reserved, the same, or a rule refuses the merge
 */
const mergeUsers = async (fromName, intoName, { dryRun = true } = {}) => {
  const from = User.findByUsername(fromName);
  const into = User.findByUsername(intoName);
  if (!from) throw new Error(`User '${fromName}' not found`);
  if (!into) throw new Error(`User '${intoName}' not found`);
  if (from.id === into.id) throw new Error('Both names are the same account');
  if (from.id === PLACEHOLDER_ID || into.id === PLACEHOLDER_ID) {
    throw new Error('The reserved placeholder account cannot be merged');
  }

  let result;
  try {
    result = mergeRows(from, into, dryRun);
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    result = error.result;
  }

  const summary = { from: from.username, into: into.username, dryRun, ...result };
  if (dryRun) return summary;

  AuditLog.tryRecord({
    action: 'account_merged',
    actor: null,
    targetUser: { id: into.id, username: into.username },
    targetKind: 'account',
    targetName: into.username,
    snippet: from.username
  });

  // Past the commit. A failure leaves an orphan file, never a half-merged account.
  for (const [remove, arg] of [[deleteAvatar, from.avatar_file], [clearAccountCache, from.id]]) {
    if (!arg) continue;
    try {
      await remove(arg);
    } catch (error) {
      console.error(`Merged ${from.username} but could not clean up ${arg}:`, error);
    }
  }

  return summary;
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const [fromName, intoName] = args.filter((arg) => !arg.startsWith('--'));

  if (!fromName || !intoName) {
    console.error('Usage: node mergeUsers.js <from> <into> [--apply]');
    process.exit(1);
  }

  mergeUsers(fromName, intoName, { dryRun: !apply })
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(`Merge refused: ${error.message}`);
      process.exit(1);
    });
}

module.exports = { mergeUsers, RULES };
