import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findTyposquatMatches, levenshtein, POPULAR_PACKAGES, unscopedName } from '../src/lib/typosquat.js';

describe('levenshtein', () => {
  it('is zero for identical strings', () => {
    assert.equal(levenshtein('lodash', 'lodash'), 0);
    assert.equal(levenshtein('', ''), 0);
  });

  it('handles empty strings', () => {
    assert.equal(levenshtein('', 'abc'), 3);
    assert.equal(levenshtein('abc', ''), 3);
  });

  it('counts single edits', () => {
    assert.equal(levenshtein('lodash', 'lodashs'), 1); // insertion
    assert.equal(levenshtein('lodash', 'odash'), 1); // deletion
    assert.equal(levenshtein('lodash', 'ladash'), 1); // substitution
  });

  it('counts multiple edits', () => {
    assert.equal(levenshtein('kitten', 'sitting'), 3);
    assert.equal(levenshtein('flaw', 'lawn'), 2);
  });

  it('is symmetric', () => {
    assert.equal(levenshtein('react', 'preact'), levenshtein('preact', 'react'));
  });

  it('exits early past the ceiling', () => {
    // The exact value past the ceiling is unspecified, but it must exceed it.
    assert.ok(levenshtein('abcdefghij', 'zyxwvutsrq', 2) > 2);
    assert.equal(levenshtein('react', 'reacr', 2), 1);
  });
});

describe('unscopedName', () => {
  it('strips the scope', () => {
    assert.equal(unscopedName('@types/node'), 'node');
    assert.equal(unscopedName('lodash'), 'lodash');
  });
});

describe('findTyposquatMatches', () => {
  it('never flags the popular package itself', () => {
    for (const name of ['react', 'lodash', 'express', 'axios']) {
      const matches = findTyposquatMatches(name);
      assert.equal(
        matches.some((match) => match.target === name),
        false,
        `${name} should not match itself`,
      );
    }
  });

  it('catches one-character substitutions', () => {
    const matches = findTyposquatMatches('lodahs');
    assert.ok(matches.some((match) => match.target === 'lodash'));
  });

  it('catches separator tricks', () => {
    const matches = findTyposquatMatches('lo-dash');
    const hit = matches.find((match) => match.target === 'lodash');
    assert.equal(hit?.technique, 'separator-swap');
  });

  it('catches digit lookalikes', () => {
    // 4 imitates a, 0 imitates o.
    assert.equal(findTyposquatMatches('re4ct').find((match) => match.target === 'react')?.technique, 'digit-substitution');
    assert.equal(findTyposquatMatches('l0dash').find((match) => match.target === 'lodash')?.technique, 'digit-substitution');
  });

  it('catches doubled characters', () => {
    const matches = findTyposquatMatches('expresss');
    const hit = matches.find((match) => match.target === 'express');
    assert.equal(hit?.technique, 'repeated-character');
  });

  it('catches a scope impersonating a popular unscoped package', () => {
    const matches = findTyposquatMatches('@react/core');
    const hit = matches.find((match) => match.target === 'react');
    assert.equal(hit?.technique, 'scope-impersonation');
  });

  it('does not flag clearly unrelated names', () => {
    assert.deepEqual(findTyposquatMatches('my-completely-unrelated-package'), []);
  });

  it('uses a tighter ceiling for short names, so vuex is not two edits from vue', () => {
    // `vue` is 3 characters: only distance-1 neighbours are considered.
    const matches = findTyposquatMatches('vuejs');
    assert.equal(
      matches.some((match) => match.target === 'vue'),
      false,
    );
  });

  it('sorts the closest impersonation first', () => {
    const matches = findTyposquatMatches('lodahs');
    const distances = matches.map((match) => match.distance);
    assert.deepEqual(distances, [...distances].sort((a, b) => a - b));
  });

  it('accepts a custom popular list', () => {
    const matches = findTyposquatMatches('interna1', ['internal'], 2);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.target, 'internal');
  });
});

describe('POPULAR_PACKAGES', () => {
  it('is frozen, lowercase and free of duplicates', () => {
    assert.ok(Object.isFrozen(POPULAR_PACKAGES));
    assert.equal(new Set(POPULAR_PACKAGES).size, POPULAR_PACKAGES.length);
    for (const name of POPULAR_PACKAGES) {
      assert.equal(name, name.toLowerCase());
    }
  });
});
