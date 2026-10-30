/**
 * The kind of network a like came from, and the switch that decides whether one is stored.
 *
 * A **Network Kind** is what the address a like came from matched on local lists: a Tor exit, a VPN, or a
 * hosting network. It is staff information and nothing more. No count, sort or acceptance reads it, and an
 * address that matched nothing stores no kind at all.
 *
 * Collection ships switched off. The privacy text has to state it before the first kind is stored, so the
 * operator turns it on after the text is live, and can turn it off again without a deploy.
 */

/** The setting that gates collection. */
const NETWORK_KIND = 'network_kind';

/** Every kind there is, in precedence order: the data-center list holds the VPN ranges too. */
const KINDS = Object.freeze(['tor', 'vpn', 'hosting']);

/**
 * The lists the classifier matches against, each downloaded to its own file.
 *
 * X4BNet's lists are MIT, built from IPLocate.io data under CC BY-SA 4.0, so the privacy policy carries
 * the credit. The Tor list has no IPv6 entries.
 */
const X4BNET = 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/output';
const NETWORK_LISTS = Object.freeze([
  { name: 'tor', kind: 'tor', url: 'https://check.torproject.org/torbulkexitlist' },
  { name: 'vpn-ipv4', kind: 'vpn', url: `${X4BNET}/vpn/ipv4.txt` },
  { name: 'vpn-ipv6', kind: 'vpn', url: `${X4BNET}/vpn/ipv6.txt` },
  { name: 'hosting-ipv4', kind: 'hosting', url: `${X4BNET}/datacenter/ipv4.txt` },
  { name: 'hosting-ipv6', kind: 'hosting', url: `${X4BNET}/datacenter/ipv6.txt` }
]);

/**
 * Whether a stored value is one this switch can act on.
 *
 * @param {*} value - Anything the settings route was handed
 * @returns {string|null} What is wrong with it, or null
 */
const validateNetworkKind = (value) =>
  typeof value === 'boolean' ? null : 'Network Kind collection must be true or false';

module.exports = { NETWORK_KIND, KINDS, NETWORK_LISTS, validateNetworkKind };
