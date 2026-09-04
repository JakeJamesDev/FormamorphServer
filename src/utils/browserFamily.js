/**
 * The coarse `Browser/OS` string stored beside a Signal's address hash.
 *
 * A tiebreaker, not an identifier. Two accounts on one address are worth a look; two accounts on one
 * address *and* one browser family are worth more, and a household reading on a phone and a laptop reads
 * as the two people it is. Low cardinality on purpose — anything finer would be a fingerprint, which is
 * exactly what this must not become.
 *
 * A small fixed table rather than a user-agent parsing dependency: the answer has six browsers and five
 * platforms in it, and a library would bring a maintained device database along for a string this coarse.
 */

/**
 * Order is the rule here, because user-agent strings lie by inheritance: Edge, Opera and Samsung all say
 * `Chrome/`, and Chrome says `Safari/`. First match wins, so the impostors are listed before the browser
 * they impersonate. The iOS entries are the same browsers under a different engine, and are the same answer.
 */
const BROWSERS = [
  ['Edge', /\bEdg[A-Za-z]*\//],
  ['Opera', /\bOPR\/|\bOpera\//],
  ['Samsung', /\bSamsungBrowser\//],
  ['Firefox', /\bFirefox\/|\bFxiOS\//],
  ['Chrome', /\bChrome\/|\bCriOS\//],
  ['Safari', /\bSafari\//]
];

/** Order matters here too: Android says `Linux`, and an iPad says `Mac OS X`. */
const SYSTEMS = [
  ['Android', /\bAndroid\b/],
  ['iOS', /\biPhone\b|\biPad\b|\biPod\b/],
  ['Windows', /\bWindows\b/],
  ['macOS', /\bMac OS X\b|\bMacintosh\b/],
  ['Linux', /\bLinux\b|\bX11\b/]
];

/** What either half becomes when nothing in its table matches. */
const UNKNOWN = 'Other';

const firstMatch = (table, agent) => {
  for (const [name, pattern] of table) if (pattern.test(agent)) return name;
  return UNKNOWN;
};

/**
 * Read a user agent as a browser family.
 *
 * @param {string} [userAgent] - The `User-Agent` header, if the client sent one
 * @returns {string} `Browser/OS`; `Other/Other` for anything the tables do not recognize
 */
const browserFamily = (userAgent) => {
  const agent = typeof userAgent === 'string' ? userAgent : '';

  return `${firstMatch(BROWSERS, agent)}/${firstMatch(SYSTEMS, agent)}`;
};

module.exports = { browserFamily };
