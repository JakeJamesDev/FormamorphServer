const { SITE_URL } = require('../config/mail');

/**
 * The link grammar of feedback bodies and comments: `#N`, `@username`, and pasted thread and listing
 * URLs. The client parses the same grammar for render positions; `tests/fixtures/feedbackLinkCases.json`
 * is the case table both copies run.
 */

/** Listing kinds the website has a page for. A model has none, so its URL is not a link. */
const LISTING_KINDS = ['world', 'entity', 'dictionary', 'prompt'];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const siteHost = () => {
  try {
    return new URL(SITE_URL).hostname.replace(/^www\./, '');
  } catch {
    return 'formamorph.ai';
  }
};

// Built once: SITE_URL is read at load, like every other use of it.
// The path ends the URL, or a query or fragment follows: `/feedback/23/comments` is not a link.
const URL_PATTERN = new RegExp(
  `https?://(?:www\\.)?${escapeRegExp(siteHost())}`
  + `(?:/feedback/([1-9]\\d{0,14})(?![\\w-])|/community/(${LISTING_KINDS.join('|')})/([^\\s/?#<>()\\[\\]]+))`
  + '/?(?=$|[\\s?#<>()\\[\\]]|[.,;:!?]+(?:$|[\\s<>()\\[\\]]))(?:[?#][^\\s<>]*)?',
  'gu'
);
/** Sentence punctuation a pasted URL is usually followed by, never part of it. */
const URL_TRAILING = /[.,;:!?)]+$/;

const THREAD_PATTERN = /#([1-9]\d{0,14})(?![\p{L}\p{N}_])/gu;
const USER_PATTERN = /@([A-Za-z0-9_-]{3,20})(?![A-Za-z0-9_-])/g;
/** A sigil links only at the start or after none of these, so `C#`, `a@b.com` and `&#23;` stay plain. */
const NO_SIGIL_AFTER = /[\p{L}\p{N}_@#&/`]/u;

/**
 * Blank out fenced code blocks and inline code spans, keeping every offset where it was.
 * @param {string} text - The post text
 * @returns {string} The text with code replaced by spaces
 */
const maskCode = (text) => {
  const chars = text.split('');
  const blank = (from, to) => { for (let i = from; i < to; i += 1) chars[i] = ' '; };

  // Fences, line by line. An unclosed fence runs to the end of the text.
  const lines = text.split('\n');
  let offset = 0;
  let fence = null;
  let fenceStart = 0;
  const prose = [];
  let proseStart = 0;
  for (const line of lines) {
    const end = offset + line.length;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && /^\s*$/.test(line.slice(marker[0].length))) {
        blank(fenceStart, end);
        fence = null;
        proseStart = end + 1;
      }
    } else if (marker && !(marker[1][0] === '`' && line.slice(marker[0].length).includes('`'))) {
      prose.push([proseStart, offset]);
      fence = marker[1];
      fenceStart = offset;
    }
    offset = end + 1;
  }
  if (fence) blank(fenceStart, text.length);
  else prose.push([proseStart, text.length]);

  // Inline code: a backtick run closes at the next run of the same length; with none, it is literal.
  for (const [from, to] of prose) {
    const runs = [...text.slice(from, to).matchAll(/`+/g)].map((run) => ({ at: from + run.index, size: run[0].length }));
    for (let i = 0; i < runs.length; i += 1) {
      const close = runs.findIndex((run, j) => j > i && run.size === runs[i].size);
      if (close === -1) continue;
      blank(runs[i].at, runs[close].at + runs[close].size);
      i = close;
    }
  }

  return chars.join('');
};

const decodeId = (raw) => {
  try {
    return decodeURIComponent(raw) || null;
  } catch {
    return null;
  }
};

/**
 * Every link in a post, in text order. Repeats are kept: each occurrence has its own position.
 * @param {string} text - A thread body or a comment, never a title
 * @returns {Array<{kind: string, ref: string, start: number, end: number}>} Links; `ref` is the thread
 *   number, `<kind>/<id>` for a listing, or the lower-cased username
 */
const parseLinks = (text) => {
  if (typeof text !== 'string' || !text) return [];
  const source = maskCode(text);
  const links = [];
  const taken = [];

  for (const match of source.matchAll(URL_PATTERN)) {
    const whole = match[0].replace(URL_TRAILING, '');
    const start = match.index;
    const end = start + whole.length;
    taken.push([start, end]);
    if (match[1]) {
      links.push({ kind: 'thread', ref: match[1], start, end });
    } else {
      const id = decodeId(match[3].replace(URL_TRAILING, ''));
      if (id) links.push({ kind: 'listing', ref: `${match[2]}/${id}`, start, end });
    }
  }

  const inUrl = (at) => taken.some(([from, to]) => at >= from && at < to);
  const sigils = [
    [THREAD_PATTERN, 'thread', (name) => name],
    [USER_PATTERN, 'user', (name) => name.toLowerCase()]
  ];
  for (const [pattern, kind, refOf] of sigils) {
    for (const match of source.matchAll(pattern)) {
      if (inUrl(match.index) || (match.index > 0 && NO_SIGIL_AFTER.test(source[match.index - 1]))) continue;
      links.push({ kind, ref: refOf(match[1]), start: match.index, end: match.index + match[0].length });
    }
  }

  return links.sort((a, b) => a.start - b.start);
};

module.exports = { parseLinks };
