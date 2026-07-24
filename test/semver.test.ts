import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyNonRegistrySpec,
  compare,
  diffType,
  isLikelyBreaking,
  isPrerelease,
  maxSatisfying,
  maxVersion,
  parse,
  parseRange,
  satisfies,
  sortDescending,
} from '../src/lib/semver.js';

describe('parse', () => {
  it('parses a plain version', () => {
    const parsed = parse('1.2.3');
    assert.deepEqual(
      { major: parsed?.major, minor: parsed?.minor, patch: parsed?.patch },
      { major: 1, minor: 2, patch: 3 },
    );
    assert.deepEqual(parsed?.prerelease, []);
  });

  it('parses prerelease and build metadata', () => {
    const parsed = parse('2.0.0-beta.11+exp.sha.5114f85');
    assert.deepEqual(parsed?.prerelease, ['beta', 11]);
    assert.equal(parsed?.build, 'exp.sha.5114f85');
  });

  it('tolerates a leading v', () => {
    assert.equal(parse('v1.0.0')?.major, 1);
  });

  it('rejects non-semver input', () => {
    for (const bad of ['1.2', 'latest', '', 'x.y.z', '1.2.3.4', 'not-a-version']) {
      assert.equal(parse(bad), null, `expected ${bad} to be unparseable`);
    }
  });
});

describe('compare', () => {
  it('orders by major, minor, then patch', () => {
    assert.equal(compare('1.0.0', '2.0.0'), -1);
    assert.equal(compare('1.2.0', '1.10.0'), -1);
    assert.equal(compare('1.0.10', '1.0.9'), 1);
    assert.equal(compare('1.0.0', '1.0.0'), 0);
  });

  it('ranks a prerelease below its release', () => {
    assert.equal(compare('1.0.0-alpha', '1.0.0'), -1);
    assert.equal(compare('1.0.0', '1.0.0-rc.1'), 1);
  });

  it('follows semver precedence for prerelease identifiers', () => {
    // From the semver spec, section 11.
    const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let i = 1; i < ordered.length; i++) {
      assert.equal(compare(ordered[i - 1]!, ordered[i]!), -1, `${ordered[i - 1]} should sort before ${ordered[i]}`);
    }
  });

  it('ignores build metadata', () => {
    assert.equal(compare('1.0.0+build.1', '1.0.0+build.2'), 0);
  });

  it('sorts descending', () => {
    assert.deepEqual(sortDescending(['1.0.0', '2.1.0', '0.9.9', '2.0.0']), ['2.1.0', '2.0.0', '1.0.0', '0.9.9']);
  });
});

describe('isPrerelease', () => {
  it('detects prereleases', () => {
    assert.equal(isPrerelease('1.0.0-beta.1'), true);
    assert.equal(isPrerelease('1.0.0'), false);
    assert.equal(isPrerelease('garbage'), false);
  });
});

describe('satisfies', () => {
  it('handles caret ranges above 1.0.0', () => {
    assert.equal(satisfies('1.5.2', '^1.2.3'), true);
    assert.equal(satisfies('1.2.2', '^1.2.3'), false);
    assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  });

  it('treats caret on 0.x as minor-locked', () => {
    assert.equal(satisfies('0.2.9', '^0.2.3'), true);
    assert.equal(satisfies('0.3.0', '^0.2.3'), false);
  });

  it('treats caret on 0.0.x as patch-locked', () => {
    assert.equal(satisfies('0.0.3', '^0.0.3'), true);
    assert.equal(satisfies('0.0.4', '^0.0.3'), false);
  });

  it('handles tilde ranges', () => {
    assert.equal(satisfies('1.2.9', '~1.2.3'), true);
    assert.equal(satisfies('1.3.0', '~1.2.3'), false);
    assert.equal(satisfies('1.9.0', '~1'), true);
    assert.equal(satisfies('2.0.0', '~1'), false);
  });

  it('handles x-ranges and wildcards', () => {
    assert.equal(satisfies('1.4.7', '1.x'), true);
    assert.equal(satisfies('2.0.0', '1.x'), false);
    assert.equal(satisfies('1.2.9', '1.2.x'), true);
    assert.equal(satisfies('9.9.9', '*'), true);
    assert.equal(satisfies('9.9.9', ''), true);
  });

  it('handles comparator sets and unions', () => {
    assert.equal(satisfies('1.5.0', '>=1.2.0 <2.0.0'), true);
    assert.equal(satisfies('2.0.0', '>=1.2.0 <2.0.0'), false);
    assert.equal(satisfies('3.1.0', '^1.0.0 || ^3.0.0'), true);
    assert.equal(satisfies('2.1.0', '^1.0.0 || ^3.0.0'), false);
  });

  it('handles hyphen ranges, including partial bounds', () => {
    assert.equal(satisfies('1.5.0', '1.2.3 - 2.3.4'), true);
    assert.equal(satisfies('2.3.5', '1.2.3 - 2.3.4'), false);
    // A partial upper bound widens to the end of that minor.
    assert.equal(satisfies('2.3.9', '1.2.3 - 2.3'), true);
    assert.equal(satisfies('2.4.0', '1.2.3 - 2.3'), false);
  });

  it('applies npm semantics to partial > and <= bounds', () => {
    assert.equal(satisfies('1.3.0', '>1.2'), true);
    assert.equal(satisfies('1.2.9', '>1.2'), false);
    assert.equal(satisfies('1.2.9', '<=1.2'), true);
    assert.equal(satisfies('1.3.0', '<=1.2'), false);
  });

  it('excludes prereleases unless the range names that tuple', () => {
    assert.equal(satisfies('2.0.0-beta.1', '^1.0.0 || ^2.0.0'), false);
    assert.equal(satisfies('2.0.0-beta.2', '>=2.0.0-beta.1'), true);
    assert.equal(satisfies('3.0.0-beta.1', '>=2.0.0-beta.1'), false);
    assert.equal(satisfies('1.5.0-beta.1', '^1.0.0'), false);
    assert.equal(satisfies('1.5.0-beta.1', '^1.0.0', { includePrerelease: true }), true);
  });

  it('uses -0 upper bounds, so a next-major prerelease never matches', () => {
    // node-semver expands ^1.0.0 to ">=1.0.0 <2.0.0-0", not "<2.0.0".
    assert.equal(satisfies('2.0.0-beta.1', '^1.0.0', { includePrerelease: true }), false);
    assert.equal(satisfies('2.0.0-beta.1', '1.x', { includePrerelease: true }), false);
    assert.equal(satisfies('1.3.0-beta.1', '~1.2.3', { includePrerelease: true }), false);
    // …but a prerelease inside the range is still allowed.
    assert.equal(satisfies('1.9.0-beta.1', '^1.0.0', { includePrerelease: true }), true);
  });

  it('is false for unparseable input rather than throwing', () => {
    assert.equal(satisfies('not-a-version', '^1.0.0'), false);
    assert.equal(satisfies('1.0.0', 'workspace:*'), false);
  });
});

describe('parseRange', () => {
  it('tolerates whitespace between operator and version', () => {
    assert.notEqual(parseRange('>= 1.2.3'), null);
    assert.equal(satisfies('1.3.0', '>= 1.2.3'), true);
  });

  it('returns null for non-semver specifiers', () => {
    assert.equal(parseRange('git+https://github.com/a/b'), null);
    assert.equal(parseRange('workspace:^'), null);
  });
});

describe('maxSatisfying', () => {
  const versions = ['1.0.0', '1.2.0', '1.4.7', '2.0.0', '2.1.0-beta.1', '0.9.0'];

  it('picks the highest stable match', () => {
    assert.equal(maxSatisfying(versions, '^1.0.0'), '1.4.7');
    assert.equal(maxSatisfying(versions, '>=1.0.0'), '2.0.0');
  });

  it('returns null when nothing matches', () => {
    assert.equal(maxSatisfying(versions, '^5.0.0'), null);
  });

  it('falls back to prereleases only when no stable version matches', () => {
    // A stable release always wins, even when a higher prerelease also matches.
    assert.equal(maxSatisfying(['1.1.0', '1.2.0-beta.1'], '^1.1.0'), '1.1.0');
    // With nothing stable in range, the prerelease is better than nothing.
    assert.equal(maxSatisfying(['1.0.0', '1.2.0-beta.1'], '^1.1.0'), '1.2.0-beta.1');
  });

  it('ignores unparseable entries in the version list', () => {
    assert.equal(maxSatisfying(['1.0.0', 'junk', '1.1.0'], '^1.0.0'), '1.1.0');
  });
});

describe('maxVersion', () => {
  it('prefers the highest stable release', () => {
    assert.equal(maxVersion(['1.0.0', '2.0.0-rc.1', '1.9.0']), '1.9.0');
  });

  it('falls back to a prerelease when there is nothing stable', () => {
    assert.equal(maxVersion(['2.0.0-rc.1', '2.0.0-rc.2']), '2.0.0-rc.2');
  });

  it('returns null for an empty or unusable list', () => {
    assert.equal(maxVersion([]), null);
    assert.equal(maxVersion(['nope']), null);
  });
});

describe('diffType', () => {
  it('classifies bumps', () => {
    assert.equal(diffType('1.0.0', '2.0.0'), 'major');
    assert.equal(diffType('1.0.0', '1.1.0'), 'minor');
    assert.equal(diffType('1.0.0', '1.0.1'), 'patch');
    assert.equal(diffType('1.0.0-a', '1.0.0-b'), 'prerelease');
    assert.equal(diffType('1.0.0', '1.0.0'), 'none');
    assert.equal(diffType('bad', '1.0.0'), null);
  });
});

describe('isLikelyBreaking', () => {
  it('flags major bumps', () => {
    assert.equal(isLikelyBreaking('1.9.9', '2.0.0'), true);
    assert.equal(isLikelyBreaking('1.0.0', '1.9.0'), false);
  });

  it('flags 0.x minor bumps, which npm treats as breaking', () => {
    assert.equal(isLikelyBreaking('0.27.2', '0.28.0'), true);
    assert.equal(isLikelyBreaking('0.27.2', '0.27.9'), false);
  });

  it('is false for unparseable versions', () => {
    assert.equal(isLikelyBreaking('nope', '1.0.0'), false);
  });
});

describe('classifyNonRegistrySpec', () => {
  it('recognises npm aliases', () => {
    assert.deepEqual(classifyNonRegistrySpec('npm:lodash@^4.0.0'), {
      kind: 'alias',
      aliasOf: { name: 'lodash', range: '^4.0.0' },
    });
  });

  it('recognises scoped aliases without splitting on the scope @', () => {
    assert.deepEqual(classifyNonRegistrySpec('npm:@scope/pkg@1.0.0'), {
      kind: 'alias',
      aliasOf: { name: '@scope/pkg', range: '1.0.0' },
    });
  });

  it('recognises non-registry protocols', () => {
    assert.equal(classifyNonRegistrySpec('workspace:*')?.kind, 'workspace');
    assert.equal(classifyNonRegistrySpec('file:../local')?.kind, 'file');
    assert.equal(classifyNonRegistrySpec('link:../local')?.kind, 'link');
    assert.equal(classifyNonRegistrySpec('git+https://github.com/a/b.git')?.kind, 'git');
    assert.equal(classifyNonRegistrySpec('https://example.com/a.tgz')?.kind, 'url');
    assert.equal(classifyNonRegistrySpec('latest')?.kind, 'tag');
  });

  it('returns null for ordinary semver ranges', () => {
    assert.equal(classifyNonRegistrySpec('^1.0.0'), null);
    assert.equal(classifyNonRegistrySpec('*'), null);
  });
});
