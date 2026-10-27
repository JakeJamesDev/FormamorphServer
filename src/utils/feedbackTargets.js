const Feedback = require('../models/Feedback');
const World = require('../models/World');
const { parseLinks } = require('./feedbackLinks');

/**
 * What a reader may know about a thread they can read.
 * @param {Object} row - A feedback row
 * @returns {{number: number, title: string, type: string, status: string}} The summary
 */
const threadSummary = (row) => ({ number: row.number, title: row.title, type: row.type, status: row.status });

/**
 * Resolve the links of many posts for one reader, in one query per link kind.
 *
 * A target the reader cannot read and one that does not exist come back the same: `available: false`
 * and nothing else. A listing resolves only while it is publicly visible, whoever is reading.
 *
 * @param {Array<string>} texts - Thread bodies and comments; titles are never passed
 * @param {Object} [reader] - The signed-in user, or none for a guest
 * @returns {function(string): Array<Object>} The distinct targets of one of those texts, in text order
 */
const resolverFor = (texts, reader) => {
  const numbers = new Set();
  const listingIds = new Set();
  for (const text of texts) {
    for (const link of parseLinks(text)) {
      if (link.kind === 'thread') numbers.add(Number(link.ref));
      else if (link.kind === 'listing') listingIds.add(link.ref.slice(link.ref.indexOf('/') + 1));
    }
  }

  const threads = new Map();
  if (numbers.size) {
    for (const row of Feedback.findByNumbers([...numbers])) {
      if (Feedback.canRead(row, reader)) threads.set(String(row.number), row);
    }
  }

  const listings = new Map();
  if (listingIds.size) {
    for (const row of World.findPublicByIds([...listingIds])) listings.set(`${row.kind}/${row.id}`, row);
  }

  const targetOf = ({ kind, ref }) => {
    if (kind === 'thread') {
      const row = threads.get(ref);
      return row ? { kind, ref, available: true, ...threadSummary(row) } : { kind, ref, available: false };
    }
    const row = listings.get(ref);
    return row
      ? {
        kind,
        ref,
        available: true,
        listingKind: row.kind,
        id: row.id,
        title: row.name,
        thumbnailUrl: `/api/thumbnails/${row.thumbnail_file.split('/').pop()}`
      }
      : { kind, ref, available: false };
  };

  return (text) => {
    const seen = new Set();
    const targets = [];
    for (const link of parseLinks(text)) {
      const key = `${link.kind}:${link.ref}`;
      // A mention carries no target here.
      if (link.kind === 'user' || seen.has(key)) continue;
      seen.add(key);
      targets.push(targetOf(link));
    }
    return targets;
  };
};

module.exports = { threadSummary, resolverFor };
