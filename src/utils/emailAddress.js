/**
 * The two forms an email address is ever needed in: the one that gets written down, and the one that
 * decides whether two spellings are the same address.
 *
 * They are separate on purpose. What is stored keeps the capitals the person typed, because that is how
 * they read their own address back. What is compared throws them away, because the unique index does
 * too — so a comparison that kept them would disagree with the constraint it exists to anticipate.
 */

/**
 * The address a request is offering, or null when it is offering none.
 *
 * A form posts every box it has, so a field that is missing, empty, or nothing but spaces all mean the
 * same thing. Anything that is not a string is not an address either.
 *
 * @param {*} value - Whatever arrived in the email field
 * @returns {string|null} The address to store, or null when the field carries none
 */
const addressGiven = (value) => {
  if (typeof value !== 'string') return null;

  return value.trim() || null;
};

/**
 * The same address as everything that compares or buckets addresses sees it.
 *
 * ASCII folding only, matching the `NOCASE` collation on the unique index. Two addresses differing
 * solely in the case of a non-ASCII letter therefore read as two addresses in both places.
 *
 * @param {*} value - Whatever arrived in the email field, or an address off a row
 * @returns {string|null} The folded address, or null when there is none
 */
const foldedAddress = (value) => {
  const address = addressGiven(value);

  return address && address.toLowerCase();
};

module.exports = { addressGiven, foldedAddress };
