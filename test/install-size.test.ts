/**
 * Tests for the registry-derived install size estimate.
 *
 * The walker is exercised against a fixture registry supplied through the
 * `fetchPackument` seam, so these run with no network access.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { estimateInstallSize, type PackumentFetcher } from '../src/lib/install-size.js';
import type { AbbreviatedPackument } from '../src/lib/npm.js';

/**
 * A miniature registry. Each entry mirrors the shape of an abbreviated
 * packument version, which is all the estimator reads.
 */
interface FakeVersion {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  unpackedSize?: number;
  fileCount?: number;
}

type FakeRegistry = Record<string, Record<string, FakeVersion>>;

/** Turns a fixture into the `fetchPackument` seam the estimator accepts. */
function fetcherFor(registry: FakeRegistry): PackumentFetcher {
  return async (name: string): Promise<AbbreviatedPackument> => {
    const entry = registry[name];
    if (!entry) throw new Error(`fake registry: no package ${name}`);
    const versionNames = Object.keys(entry);
    return {
      name,
      distTags: { latest: versionNames[versionNames.length - 1]! },
      versions: Object.fromEntries(
        Object.entries(entry).map(([version, value]) => [
          version,
          {
            dependencies: value.dependencies,
            optionalDependencies: value.optionalDependencies,
            peerDependencies: value.peerDependencies,
            peerDependenciesMeta: value.peerDependenciesMeta,
            dist: { unpackedSize: value.unpackedSize, fileCount: value.fileCount },
          },
        ]),
      ),
    };
  };
}

const KB = 1024;

describe('estimateInstallSize', () => {
    it('sums the root plus its transitive dependencies', async () => {
    const fetchPackument = fetcherFor({
      root: { '1.0.0': { dependencies: { mid: '^1.0.0' }, unpackedSize: 1 * KB, fileCount: 2 } },
      mid: { '1.2.0': { dependencies: { leaf: '^2.0.0' }, unpackedSize: 2 * KB, fileCount: 3 } },
      leaf: { '2.1.0': { unpackedSize: 4 * KB, fileCount: 5 } },
    });

    const result = await estimateInstallSize('root', '1.0.0', { fetchPackument });
    assert.equal(result.totalBytes, 7 * KB);
    assert.equal(result.totalFiles, 10);
    assert.equal(result.packageCount, 3);
    assert.equal(result.selfBytes, 1 * KB);
    assert.equal(result.coverage, 1);
    assert.equal(result.truncated, false);
  });

  it('counts a shared dependency once (approximating hoisting)', async () => {
    const fetchPackument = fetcherFor({
      root: { '1.0.0': { dependencies: { a: '^1.0.0', b: '^1.0.0' }, unpackedSize: 1000 } },
      a: { '1.0.0': { dependencies: { shared: '^1.0.0' }, unpackedSize: 100 } },
      b: { '1.0.0': { dependencies: { shared: '^1.0.0' }, unpackedSize: 100 } },
      shared: { '1.0.0': { unpackedSize: 500 } },
    });

    const result = await estimateInstallSize('root', '1.0.0', { fetchPackument });
    // 1000 + 100 + 100 + 500 — `shared` is not double counted.
    assert.equal(result.totalBytes, 1700);
    assert.equal(result.packageCount, 4);
  });

  it('counts each version separately when a package resolves to two, and reports the conflict', async () => {
    const fetchPackument = fetcherFor({
      root: { '1.0.0': { dependencies: { a: '^1.0.0', b: '^1.0.0' }, unpackedSize: 0 } },
      a: { '1.0.0': { dependencies: { dup: '^1.0.0' }, unpackedSize: 0 } },
      b: { '1.0.0': { dependencies: { dup: '^2.0.0' }, unpackedSize: 0 } },
      dup: { '1.5.0': { unpackedSize: 300 }, '2.0.0': { unpackedSize: 400 } },
    });

    const result = await estimateInstallSize('root', '1.0.0', { fetchPackument });
    assert.equal(result.totalBytes, 700, 'both copies must be counted');
    assert.equal(result.uniqueNames, 4);
    assert.equal(result.packageCount, 5);
    assert.deepEqual(result.conflictingPackages, [{ name: 'dup', versions: ['1.5.0', '2.0.0'] }]);
  });

  it('terminates on a dependency cycle', async () => {
    const fetchPackument = fetcherFor({
      root: { '1.0.0': { dependencies: { a: '^1.0.0' }, unpackedSize: 10 } },
      a: { '1.0.0': { dependencies: { b: '^1.0.0' }, unpackedSize: 20 } },
      b: { '1.0.0': { dependencies: { a: '^1.0.0' }, unpackedSize: 30 } },
    });

    const result = await estimateInstallSize('root', '1.0.0', { fetchPackument });
    assert.equal(result.totalBytes, 60);
    assert.equal(result.packageCount, 3);
  });

  it('tracks optional dependency bytes separately but inside the total', async () => {
    const fetchPackument = fetcherFor({
      root: { '1.0.0': { dependencies: { req: '^1.0.0' }, optionalDependencies: { opt: '^1.0.0' }, unpackedSize: 100 } },
      req: { '1.0.0': { unpackedSize: 200 } },
      opt: { '1.0.0': { unpackedSize: 900 } },
    });

    const result = await estimateInstallSize('root', '1.0.0', { fetchPackument });
    assert.equal(result.totalBytes, 1200);
    assert.equal(result.optionalBytes, 900);
  });

  it('treats children of an optional package as optional too', async () => {
    const fetchPackument = fetcherFor({
      root: { '1.0.0': { optionalDependencies: { opt: '^1.0.0' }, unpackedSize: 0 } },
      opt: { '1.0.0': { dependencies: { child: '^1.0.0' }, unpackedSize: 10 } },
      child: { '1.0.0': { unpackedSize: 90 } },
    });

    const result = await estimateInstallSize('root', '1.0.0', { fetchPackument });
    assert.equal(result.optionalBytes, 100, 'an optional subtree is entirely optional');
  });

  it('includes non-optional peers but skips optional ones', async () => {
    const registry: FakeRegistry = {
      root: {
        '1.0.0': {
          peerDependencies: { peer: '^1.0.0', optPeer: '^1.0.0' },
          peerDependenciesMeta: { optPeer: { optional: true } },
          unpackedSize: 10,
        },
      },
      peer: { '1.0.0': { unpackedSize: 500 } },
      optPeer: { '1.0.0': { unpackedSize: 9000 } },
    };

    const fetchPackument = fetcherFor(registry);
    const included = await estimateInstallSize('root', '1.0.0', { fetchPackument });
    assert.equal(included.totalBytes, 510, 'the required peer counts, the optional one does not');

    const excluded = await estimateInstallSize('root', '1.0.0', { fetchPackument, includePeer: false });
    assert.equal(excluded.totalBytes, 10);
  });

  it('reports coverage when a package publishes no unpackedSize', async () => {
    const fetchPackument = fetcherFor({
      root: { '1.0.0': { dependencies: { old: '^1.0.0' }, unpackedSize: 100 } },
      old: { '1.0.0': {} }, // pre-dates unpackedSize
    });

    const result = await estimateInstallSize('root', '1.0.0', { fetchPackument });
    assert.equal(result.totalBytes, 100, 'unknown sizes contribute nothing rather than NaN');
    assert.equal(result.missingSizeCount, 1);
    assert.deepEqual(result.missingSizePackages, ['old@1.0.0']);
    assert.equal(result.coverage, 0.5);
  });

  it('stops at the node cap and flags the total as a lower bound', async () => {
    const registry: FakeRegistry = {
      root: { '1.0.0': { dependencies: { d0: '^1.0.0' }, unpackedSize: 1 } },
    };
    for (let i = 0; i < 30; i++) {
      registry[`d${i}`] = { '1.0.0': { dependencies: { [`d${i + 1}`]: '^1.0.0' }, unpackedSize: 1 } };
    }
    registry.d30 = { '1.0.0': { unpackedSize: 1 } };

    const fetchPackument = fetcherFor(registry);
    const result = await estimateInstallSize('root', '1.0.0', { fetchPackument, maxNodes: 5 });
    assert.equal(result.truncated, true);
    assert.match(result.truncationReason ?? '', /lower bound/);
    assert.ok(result.packageCount <= 6, `expected the cap to hold, got ${result.packageCount}`);
  });

  it('stops at the depth limit and says so', async () => {
    const fetchPackument = fetcherFor({
      root: { '1.0.0': { dependencies: { a: '^1.0.0' }, unpackedSize: 1 } },
      a: { '1.0.0': { dependencies: { b: '^1.0.0' }, unpackedSize: 1 } },
      b: { '1.0.0': { dependencies: { c: '^1.0.0' }, unpackedSize: 1 } },
      c: { '1.0.0': { unpackedSize: 1 } },
    });

    const result = await estimateInstallSize('root', '1.0.0', { fetchPackument, depth: 1 });
    assert.equal(result.packageCount, 2, 'root + one level');
    assert.equal(result.truncated, true);
    assert.match(result.truncationReason ?? '', /depth/);
  });

  it('skips dependencies that cannot be resolved from the registry', async () => {
    const fetchPackument = fetcherFor({
      root: {
        '1.0.0': {
          dependencies: { normal: '^1.0.0', fromGit: 'git+https://example.com/a/b.git' },
          unpackedSize: 10,
        },
      },
      normal: { '1.0.0': { unpackedSize: 90 } },
    });

    const result = await estimateInstallSize('root', '1.0.0', { fetchPackument });
    assert.equal(result.totalBytes, 100);
    assert.equal(result.packageCount, 2, 'the git dependency contributes nothing and does not throw');
  });

  it('handles a zero-dependency package', async () => {
    const fetchPackument = fetcherFor({
      root: { '1.0.0': { unpackedSize: 44342, fileCount: 12 } },
    });

    const result = await estimateInstallSize('root', '1.0.0', { fetchPackument });
    assert.equal(result.totalBytes, 44342);
    assert.equal(result.packageCount, 1);
    assert.equal(result.uniqueNames, 1);
    assert.equal(result.depthReached, 0);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.conflictingPackages, []);
  });

  it('ranks the heaviest packages first', async () => {
    const fetchPackument = fetcherFor({
      root: { '1.0.0': { dependencies: { small: '^1.0.0', big: '^1.0.0' }, unpackedSize: 50 } },
      small: { '1.0.0': { unpackedSize: 10 } },
      big: { '1.0.0': { unpackedSize: 5000 } },
    });

    const result = await estimateInstallSize('root', '1.0.0', { fetchPackument });
    assert.equal(result.heaviestPackages[0]?.name, 'big');
    assert.equal(result.heaviestPackages.at(-1)?.name, 'small');
  });
});
