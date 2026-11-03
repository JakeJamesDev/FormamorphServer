import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
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

describe('the shipped default Avatar list', () => {
  const shipped = loadBundledFingerprints(path.join(paths.PROJECT_ROOT, 'src', 'config', 'bundledFingerprints.json')).avatars;
  const SIBLING = path.resolve(paths.PROJECT_ROOT, '..', 'formamorph');

  // Sei, Aki, and Praline.
  const CURRENT = [
    '5cce5f17db28bb4199477b46984edcfc1f07e23e99130ce0bdcd0c9ba50db2c5',
    'c9a6e90adc29f2a0067bf43cee8b4758e217e34ad05ec14363fa608688d5323a',
    '04da10f7713aea1abd7f8903017ba9420c925b8980a25817b6a80bb9285a22f4',
  ];
  // Every hash the list held before the replacement, Elaina's among them. Releases already out ship these files.
  const PREVIOUS = [
    '096aa26fc8fb4adcc81be4c96d0904b1e247d412bbc671c372f4896554edbe3c',
    '213a46c0dcc2e17615867f14b7cbb8ab9cd07997e7e1873aeff52288442eed36',
    '7093babdacd8b745d81c4beb4fdfee9c1325206ae578d6a0c7d77bb2c9d8deab',
    'af72fbe9335679fbcdd1d6bf6e798682b4a5fba84d42e98947968ab07175d520',
    'ff832498411f730270c28f5feeafe01c6c31a8ba4f183354a66215cc1359ee33',
    'd9b84905d76d82824b2fac975dd554fa68e1bcf6f73f85b1fa6b2bb07cf6f6c9',
  ];

  it.each(CURRENT)('refuses the current default Avatar %s', (hash) => {
    expect(shipped.has(hash)).toBe(true);
  });

  it.each(PREVIOUS)('still refuses the earlier default Avatar %s', (hash) => {
    expect(shipped.has(hash)).toBe(true);
  });

  // Real files from the sibling checkout. Skipped when it is absent, as in a worktree.
  const files = [
    ['public', 'default-avatar.vrm'],
    ['build-assets', 'alternate-avatar.vrm'],
    ['build-assets', 'praline-avatar.vrm'],
  ].map((parts) => path.join(SIBLING, ...parts));
  for (const file of files) {
    const runner = fs.existsSync(file) ? it : it.skip;
    runner(`refuses the file ${path.basename(file)} and passes an edited copy`, () => {
      const bytes = fs.readFileSync(file);
      expect(shipped.has(sha256Hex(bytes))).toBe(true);
      expect(shipped.has(sha256Hex(Buffer.concat([bytes, Buffer.from([0])])))).toBe(false);
    });
  }
});
