/**
 * Builds real GLB/VRM bytes for tests, so the container parsing under test is exercised rather than
 * stubbed. Shared by the license gate's unit tests and the model-kind route tests.
 *
 * Port of the client's `src/test/glbFixture.ts`, narrowed to what the server side needs: no binary-chunk
 * image encoding, since the server never reads a VRM's thumbnail.
 */

const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const GLB_MAGIC = 0x46546c67;

/** Assemble a GLB from a glTF JSON object and an optional binary chunk. */
function makeGlb(json, bin) {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonPadded = Buffer.concat([jsonBytes, Buffer.alloc(pad, 0x20)]); // GLB pads JSON with spaces

  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + (bin ? 8 + bin.length : 0), 8);

  const jsonChunkHeader = Buffer.alloc(8);
  jsonChunkHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonChunkHeader.writeUInt32LE(CHUNK_JSON, 4);

  const parts = [header, jsonChunkHeader, jsonPadded];
  if (bin) {
    const binChunkHeader = Buffer.alloc(8);
    binChunkHeader.writeUInt32LE(bin.length, 0);
    binChunkHeader.writeUInt32LE(CHUNK_BIN, 4);
    parts.push(binChunkHeader, bin);
  }
  return Buffer.concat(parts);
}

/** A VRM 1.0 file carrying `meta`. */
const makeVrm1 = (meta, bin) => makeGlb({ extensions: { VRMC_vrm: { meta } } }, bin);

/** A VRM 0.0 file carrying `meta`. */
const makeVrm0 = (meta) => makeGlb({ extensions: { VRM: { meta } } });

/** A `.glb` with no VRM extension at all. */
const makePlainGltf = () => makeGlb({ asset: { version: '2.0' } });

module.exports = { makeGlb, makeVrm1, makeVrm0, makePlainGltf };
