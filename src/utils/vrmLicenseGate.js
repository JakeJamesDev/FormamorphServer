const { MODEL_LICENSE_REQUIREMENTS } = require('../config/kinds');

/**
 * Reads a VRM's rights metadata straight out of its GLB JSON chunk and runs the Permissive License gate
 * against it.
 *
 * Only the GLB header and JSON chunk are ever read; the binary chunk (mesh, textures) is never decoded.
 * This is a server-side port of the client's `readVrmMeta` container parsing, narrowed to the handful of
 * fields the gate needs — the server has no use for a VRM's title, authors, or embedded thumbnail.
 */

// GLB container: a 12-byte header, then length-prefixed chunks. Values are little-endian.
const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

/** Absence is failure, never permission — a stand-in for a VRM this repo could not identify at all. */
const UNKNOWN_META = { metaVersion: null };

/** Pull the glTF JSON out of a GLB buffer, or null when the bytes aren't a well-formed GLB. */
function parseGlbJson(buffer) {
  if (buffer.length < HEADER_BYTES || buffer.readUInt32LE(0) !== GLB_MAGIC) return null;

  let offset = HEADER_BYTES;
  while (offset + CHUNK_HEADER_BYTES <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + CHUNK_HEADER_BYTES;
    if (start + length > buffer.length) break; // truncated file — nothing clean left to read

    if (type === CHUNK_JSON) {
      // The spec pads this chunk with trailing spaces; strip NULs too, for a non-conforming exporter.
      const text = buffer.toString('utf8', start, start + length).replace(/\0+$/, '');
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
    // Anything else — the binary chunk included — is skipped over by its length, never inspected.
    offset = start + length;
  }
  return null;
}

/**
 * Read a VRM's license-relevant metadata from its raw file bytes.
 *
 * @param {Buffer} bytes - The `.vrm` file's own bytes (a GLB container)
 * @returns {{metaVersion: '0'|'1'|null, avatarPermission?: string, allowRedistribution?: boolean, modification?: string, commercialUsage?: string}}
 */
function readVrmLicenseMeta(bytes) {
  const json = parseGlbJson(bytes);
  if (!json || !json.extensions) return UNKNOWN_META;

  const v1 = json.extensions.VRMC_vrm && json.extensions.VRMC_vrm.meta;
  if (v1) {
    return {
      metaVersion: '1',
      avatarPermission: v1.avatarPermission,
      allowRedistribution: v1.allowRedistribution,
      modification: v1.modification,
      commercialUsage: v1.commercialUsage,
    };
  }

  // VRM 0.0 carries none of the fields the gate checks; reported so callers can tell "wrong version" from
  // "not a VRM at all", even though both fail the gate the same way.
  if (json.extensions.VRM && json.extensions.VRM.meta) return { metaVersion: '0' };

  return UNKNOWN_META;
}

/**
 * The Permissive License gate. Every requirement is checked independently, so a VRM 0.0 file or a plain
 * glTF — which supply none of them — fails every requirement rather than short-circuiting on the version.
 *
 * @param {object} meta - As returned by `readVrmLicenseMeta`
 * @returns {{allowed: boolean, failedRequirements: string[]}}
 */
function licenseGate(meta) {
  const failedRequirements = [];

  if (meta.metaVersion !== '1') failedRequirements.push('metaVersion');
  if (meta.avatarPermission !== 'everyone') failedRequirements.push('avatarPermission');
  if (meta.allowRedistribution !== true) failedRequirements.push('allowRedistribution');
  if (meta.modification !== 'allowModificationRedistribution') failedRequirements.push('modification');
  if (meta.commercialUsage !== 'personalProfit' && meta.commercialUsage !== 'corporation') {
    failedRequirements.push('commercialUsage');
  }

  return { allowed: failedRequirements.length === 0, failedRequirements };
}

module.exports = { readVrmLicenseMeta, licenseGate, MODEL_LICENSE_REQUIREMENTS };
