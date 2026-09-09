import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { makeGlb, makeVrm1, makeVrm0, makePlainGltf } from './glbFixture.js';

const require = createRequire(import.meta.url);
const { readVrmLicenseMeta, licenseGate, normalizeVrmLicense, MODEL_LICENSE_REQUIREMENTS } = require('../src/utils/vrmLicenseGate');

/** Meta that satisfies every requirement of the Permissive License gate. */
const PASSING_META = {
  avatarPermission: 'everyone',
  allowRedistribution: true,
  modification: 'allowModificationRedistribution',
  commercialUsage: 'corporation',
};

/** One way to break each requirement in isolation, keeping every other field passing. */
const BREAKS = {
  metaVersion: { metaVersion: '0' },
  avatarPermission: { avatarPermission: 'onlyAuthor' },
  allowRedistribution: { allowRedistribution: false },
  modification: { modification: 'prohibited' },
  commercialUsage: { commercialUsage: 'personalNonProfit' },
};

describe('readVrmLicenseMeta', () => {
  it("reads a VRM 1.0 file's license fields", () => {
    expect(readVrmLicenseMeta(makeVrm1(PASSING_META))).toEqual({ metaVersion: '1', ...PASSING_META });
  });

  it('reports VRM 0.0 by its version, with none of the 1.0 fields', () => {
    expect(readVrmLicenseMeta(makeVrm0({ title: 'Old Format' }))).toEqual({ metaVersion: '0' });
  });

  it('reports a plain glTF as unknown', () => {
    expect(readVrmLicenseMeta(makePlainGltf())).toEqual({ metaVersion: null });
  });

  it('reports a glTF with an unrelated extension as unknown, not as some other version', () => {
    expect(readVrmLicenseMeta(makeGlb({ extensions: { KHR_materials_unlit: {} } }))).toEqual({ metaVersion: null });
  });

  it('reports a GLB whose JSON chunk is not valid JSON as unknown, rather than throwing', () => {
    const glb = makeGlb({ extensions: { VRMC_vrm: { meta: PASSING_META } } });
    // Corrupt one byte inside the JSON chunk's text, after the header and chunk headers (byte 21 sits
    // inside the opening `{"extensions"...` payload).
    glb[21] = 0x00;
    expect(readVrmLicenseMeta(glb)).toEqual({ metaVersion: null });
  });

  it('reports bytes that are not a GLB at all as unknown, rather than throwing', () => {
    expect(readVrmLicenseMeta(Buffer.from('not a glb'))).toEqual({ metaVersion: null });
  });

  it('skips past a chunk that is neither JSON nor the one it is looking for', () => {
    // Not a real-world GLB (the JSON chunk must be first per spec), but proves the scan loop steps over
    // an unrecognized chunk by its length rather than assuming the first chunk is always JSON.
    const dummyType = 0x594d4d44; // 'DMMY', little-endian
    const dummy = Buffer.from('padding!'); // 8 bytes, already a multiple of 4
    const dummyHeader = Buffer.alloc(8);
    dummyHeader.writeUInt32LE(dummy.length, 0);
    dummyHeader.writeUInt32LE(dummyType, 4);

    const json = makeGlb({ extensions: { VRMC_vrm: { meta: PASSING_META } } });
    const header = Buffer.alloc(12);
    header.writeUInt32LE(0x46546c67, 0); // GLB_MAGIC
    header.writeUInt32LE(2, 4);
    const jsonWithoutHeader = json.subarray(12);
    header.writeUInt32LE(12 + dummyHeader.length + dummy.length + jsonWithoutHeader.length, 8);

    const glb = Buffer.concat([header, dummyHeader, dummy, jsonWithoutHeader]);
    expect(readVrmLicenseMeta(glb)).toEqual({ metaVersion: '1', ...PASSING_META });
  });

  it('reports a truncated GLB as unknown, rather than throwing', () => {
    const whole = makeVrm1(PASSING_META);
    expect(readVrmLicenseMeta(whole.subarray(0, 20))).toEqual({ metaVersion: null });
  });

  it("never reads the binary chunk, even a corrupt one", () => {
    // If this module ever touched the BIN chunk's bytes, garbage that is neither valid UTF-8 JSON nor
    // anything else parseable would be the mechanic that surfaces it — a decode attempt here would throw
    // or return the wrong meta. Passing the license fields back unchanged is what "never decoded" means.
    const corruptBin = Buffer.from([0xff, 0xfe, 0x00, 0x01, 0xff]);
    expect(readVrmLicenseMeta(makeVrm1(PASSING_META, corruptBin))).toEqual({ metaVersion: '1', ...PASSING_META });
  });
});

describe('licenseGate', () => {
  it('allows a VRM 1.0 file that meets every requirement', () => {
    expect(licenseGate({ metaVersion: '1', ...PASSING_META })).toEqual({ allowed: true, failedRequirements: [] });
  });

  it('allows personalProfit commercial use, not only corporation', () => {
    const meta = { metaVersion: '1', ...PASSING_META, commercialUsage: 'personalProfit' };
    expect(licenseGate(meta)).toEqual({ allowed: true, failedRequirements: [] });
  });

  for (const requirement of MODEL_LICENSE_REQUIREMENTS) {
    it(`fails only '${requirement}' when just that requirement is broken`, () => {
      const meta = { metaVersion: '1', ...PASSING_META, ...BREAKS[requirement] };
      expect(licenseGate(meta)).toEqual({ allowed: false, failedRequirements: [requirement] });
    });
  }

  it('rejects VRM 0.0, failing every requirement — none of them is ever supplied', () => {
    const result = licenseGate(readVrmLicenseMeta(makeVrm0({ title: 'Old Format' })));
    expect(result.allowed).toBe(false);
    expect(result.failedRequirements.slice().sort()).toEqual(MODEL_LICENSE_REQUIREMENTS.slice().sort());
  });

  it('rejects a plain glTF, failing every requirement', () => {
    const result = licenseGate(readVrmLicenseMeta(makePlainGltf()));
    expect(result.allowed).toBe(false);
    expect(result.failedRequirements.slice().sort()).toEqual(MODEL_LICENSE_REQUIREMENTS.slice().sort());
  });

  it('treats one missing field as that field failing, never as permission', () => {
    const { avatarPermission, ...withoutPermission } = { metaVersion: '1', ...PASSING_META };
    expect(licenseGate(withoutPermission)).toEqual({ allowed: false, failedRequirements: ['avatarPermission'] });
  });
});

describe('normalizeVrmLicense', () => {
  /** VRM 1.0 meta carrying everything a reader is shown, not just what the gate checks. */
  const FULL_META = {
    ...PASSING_META,
    name: 'Sedge',
    authors: ['Alice', 'Bob'],
    licenseUrl: 'https://example.test/license',
    creditNotation: 'required',
  };

  it("reports a VRM 1.0 file's license in the shape the client renders", () => {
    expect(normalizeVrmLicense(readVrmLicenseMeta(makeVrm1(FULL_META)))).toEqual({
      metaVersion: '1',
      title: 'Sedge',
      authors: ['Alice', 'Bob'],
      licenseUrl: 'https://example.test/license',
      allowRedistribution: true,
      commercialUse: 'corporation',
      creditRequired: true,
      avatarPermission: 'everyone',
      modification: 'allowModificationRedistribution',
    });
  });

  it('reads credit as not required when the file says so, and as unknown when it says nothing', () => {
    const notRequired = normalizeVrmLicense(readVrmLicenseMeta(makeVrm1({ ...FULL_META, creditNotation: 'unnecessary' })));
    expect(notRequired.creditRequired).toBe(false);

    const silent = normalizeVrmLicense(readVrmLicenseMeta(makeVrm1(PASSING_META)));
    expect(silent.creditRequired).toBeUndefined();
  });

  it('drops an enum value it does not recognize rather than passing it through', () => {
    // A reader maps each enum to its own copy; an unknown string would render as nothing at all, so it
    // is reported as unknown instead — the same rule the whole gate runs on.
    const license = normalizeVrmLicense(readVrmLicenseMeta(makeVrm1({ ...PASSING_META, commercialUsage: 'inventedTier' })));
    expect(license.commercialUse).toBeUndefined();
  });

  it('reports an empty author list as unknown rather than as a credited nobody', () => {
    const license = normalizeVrmLicense(readVrmLicenseMeta(makeVrm1({ ...PASSING_META, authors: [] })));
    expect(license.authors).toBeUndefined();
  });

  it('reports a file the gate rejects by its version, claiming nothing else about it', () => {
    expect(normalizeVrmLicense(readVrmLicenseMeta(makeVrm0({ title: 'Old Format' })))).toEqual({ metaVersion: '0' });
    expect(normalizeVrmLicense(readVrmLicenseMeta(makePlainGltf()))).toEqual({ metaVersion: null });
  });
});
