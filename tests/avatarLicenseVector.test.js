import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { makeVrm1, makeVrm0, makePlainGltf } from './glbFixture.js';

const require = createRequire(import.meta.url);
const { readVrmLicenseMeta, licenseGate } = require('../src/utils/vrmLicenseGate');
// A byte-for-byte copy of the client's `src/lib/__fixtures__/avatar-license-vector.json`.
const vector = require('./fixtures/avatar-license-vector.json');

const BUILD = { vrm1: makeVrm1, vrm0: makeVrm0, plain: () => makePlainGltf() };

describe('the shared avatar license vector', () => {
  it('holds a passing case', () => {
    expect(vector.cases.some((c) => c.failed.length === 0)).toBe(true);
  });

  for (const { name, kind, meta, failed } of vector.cases) {
    it(`${name}: fails exactly [${failed.join(', ')}]`, () => {
      const verdict = licenseGate(readVrmLicenseMeta(BUILD[kind](meta)));
      expect(verdict).toEqual({ allowed: failed.length === 0, failedRequirements: failed });
    });
  }
});
