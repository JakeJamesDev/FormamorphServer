const net = require('net');
const { KINDS, NETWORK_LISTS } = require('../config/networkKind');

const FAMILY = { 4: 'ipv4', 6: 'ipv6' };

const notAnEntry = (line) => new Error(`Not an address or a CIDR: ${line.slice(0, 64)}`);

/**
 * Read one list's text into a `BlockList`, or say why it cannot be.
 *
 * All or nothing: one line that is not an address or a CIDR refuses the whole list, because a download cut
 * short or an error page served as text reads as a few good lines and then rubbish. Blank lines and `#`
 * comments are skipped. A list with no entries is refused too, since an empty file is no list.
 *
 * @param {string} text - The list as downloaded or read from disk
 * @returns {{ list: net.BlockList, entries: number }} The parsed list
 * @throws {Error} The first line that does not parse, or that the list is empty
 */
const parseList = (text) => {
  const list = new net.BlockList();
  let entries = 0;

  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const [address, prefix, extra] = line.split('/');
    const family = FAMILY[net.isIP(address)];
    if (!family || extra !== undefined || (prefix !== undefined && !/^\d+$/.test(prefix))) {
      throw notAnEntry(line);
    }

    try {
      if (prefix === undefined) list.addAddress(address, family);
      else list.addSubnet(address, Number(prefix), family);
    } catch {
      throw notAnEntry(line);
    }
    entries += 1;
  }

  if (entries === 0) throw new Error('The list has no entries');

  return { list, entries };
};

/**
 * Match an address against the Tor, VPN and hosting lists, all held in memory.
 *
 * Each list loads on its own, so one that fails keeps whatever copy came before it while the rest move on.
 * Until a list has loaded it matches nothing, so a fresh install classifies every address as none rather
 * than failing a like.
 *
 * @returns {Object} `{ load, classify, loadedAt }`
 */
const createNetworkClassifier = () => {
  const loaded = new Map();

  return {
    /**
     * Put a list in place of its previous copy. A list that does not parse leaves the previous copy in use.
     *
     * @param {string} name - One of `NETWORK_LISTS`
     * @param {string} text - The list's text
     * @returns {number} How many entries it holds
     * @throws {Error} When the name is unknown or the text does not parse
     */
    load: (name, text) => {
      const source = NETWORK_LISTS.find((entry) => entry.name === name);
      if (!source) throw new Error(`No such network list: ${name}`);

      const { list, entries } = parseList(text);
      loaded.set(name, { kind: source.kind, list, at: new Date().toISOString() });

      return entries;
    },

    /**
     * The kind of network an address belongs to, Tor before VPN before hosting.
     *
     * @param {string} address - The client address, as `utils/clientAddress` resolves it
     * @returns {string|null} One of `KINDS`, or null when nothing matched or nothing is loaded
     */
    classify: (address) => {
      const family = FAMILY[net.isIP(address)];
      if (!family) return null;

      for (const kind of KINDS) {
        for (const entry of loaded.values()) {
          if (entry.kind === kind && entry.list.check(address, family)) return kind;
        }
      }

      return null;
    },

    /**
     * When each list was last loaded.
     *
     * @returns {Object} ISO stamps by list name; a list never loaded is absent
     */
    loadedAt: () => Object.fromEntries([...loaded].map(([name, entry]) => [name, entry.at]))
  };
};

/** The classifier the like routes read and the daily refresh writes. */
const networkClassifier = createNetworkClassifier();

module.exports = { createNetworkClassifier, networkClassifier, parseList };
