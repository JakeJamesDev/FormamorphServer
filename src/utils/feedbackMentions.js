const User = require('../models/User');
const { roleOf } = require('../config/roles');
const { parseLinks } = require('./feedbackLinks');
const { liftExpiredSuspension } = require('./liftSuspension');
const { pickByName } = require('./accountByName');

/** Distinct mentioned users per post, by the writer's role; admins have none. */
const MENTION_CAPS = { normal: 5, mod: 10, dev: 10, admin: Infinity };

/**
 * The cap on distinct users one post may mention.
 * @param {Object} user - The writer
 * @returns {number} The cap, `Infinity` for none
 */
const mentionCap = (user) => MENTION_CAPS[roleOf(user)] ?? MENTION_CAPS.normal;

/** Each mentioned name in a post, lower-cased, mapped to its first spelling as typed. */
const typedNames = (text) => {
  const names = new Map();
  for (const link of parseLinks(text)) {
    if (link.kind === 'user' && !names.has(link.ref)) names.set(link.ref, text.slice(link.start + 1, link.end));
  }
  return names;
};

/**
 * The accounts the mentions in many posts reach, in one query however many names.
 * @param {Array<string>} texts - Thread bodies and comments
 * @returns {function(string): Map<string, Object|null>} For one of those texts, each mentioned name
 *   (lower-cased, in text order) and the account it reaches, or null
 */
const accountsFor = (texts) => {
  const perText = new Map(texts.filter(Boolean).map((text) => [text, typedNames(text)]));
  const refs = new Set([...perText.values()].flatMap((names) => [...names.keys()]));

  const candidates = new Map();
  if (refs.size) {
    for (const row of User.findAllUnflaggedByUsernamesFolded([...refs])) {
      const key = row.username.toLowerCase();
      if (!candidates.has(key)) candidates.set(key, []);
      candidates.get(key).push(liftExpiredSuspension(row));
    }
  }

  return (text) => {
    const names = perText.get(text) || new Map();
    return new Map([...names].map(([ref, typed]) => [ref, pickByName(candidates.get(ref) || [], typed)]));
  };
};

/**
 * The distinct users a post mentions, as its writer records them, with unknown names and the writer
 * dropped; or the refusal when they are more than the writer's cap.
 * @param {string} text - A thread body or a comment
 * @param {Object} writer - The signed-in user writing it
 * @returns {{mentions: Array<string>, error: string|null}} User ids in text order, and the refusal
 */
const mentionsOf = (text, writer) => {
  const ids = [...accountsFor([text])(text).values()]
    .filter((user) => user && user.id !== writer.id)
    .map((user) => user.id);
  const mentions = [...new Set(ids)];
  const cap = mentionCap(writer);
  return { mentions, error: mentions.length > cap ? `A post can mention up to ${cap} people` : null };
};

module.exports = { accountsFor, mentionsOf };
