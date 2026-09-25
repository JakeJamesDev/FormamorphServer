import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';
import { paths } from './context.js';

const require = createRequire(import.meta.url);
const { sha256Hex, worldFingerprint, loadBundledFingerprints } = require('../src/utils/bundledFingerprint');
const vector = require('./fixtures/bundled-fingerprint-vector.json');

describe('worldFingerprint', () => {
  // A copy of the client's vector, so both implementations are pinned to one answer.
  it('matches the shared test vector', () => {
    expect(worldFingerprint(vector.world)).toBe(vector.fingerprint);
  });

  it('hashes bytes as lowercase hex SHA-256', () => {
    // The SHA-256 of "abc", from FIPS 180-2.
    expect(sha256Hex(Buffer.from('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('changes when a long text value changes', () => {
    const edited = structuredClone(vector.world);
    edited.stats[0].description = 'Rises every turn and drops when the player eats a snack.';
    expect(worldFingerprint(edited)).not.toBe(vector.fingerprint);
  });

  it('ignores stat code, short values, and whitespace', () => {
    const edited = structuredClone(vector.world);
    edited.stats[0].code = 'return self.value - 2; // stat code changed by a migration, not by the author';
    edited.worldOverview.name = 'Renamed';
    edited.entities[0].aiDescription = ' Ada keeps the lighthouse lamp  burning through every storm.\n';
    expect(worldFingerprint(edited)).toBe(vector.fingerprint);
  });
});

describe('the bundled fingerprint list', () => {
  const HEX = /^[0-9a-f]{64}$/;

  it('loads the shipped list into sets', () => {
    const shipped = path.join(paths.PROJECT_ROOT, 'src', 'config', 'bundledFingerprints.json');
    const raw = require(shipped);
    const list = loadBundledFingerprints(shipped);

    expect(list.worlds).toBeInstanceOf(Set);
    expect(list.worlds.size).toBe(raw.worlds.length);
    expect(list.avatars.size).toBe(raw.avatars.length);
    expect(list.worlds.size).toBeGreaterThan(0);
    for (const hex of [...list.worlds, ...list.avatars]) expect(hex).toMatch(HEX);
  });
});
