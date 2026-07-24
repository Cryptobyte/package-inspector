import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { diffDependencies } from '../src/tools/compare-versions.js';
import { collectEdges, computeHeaviestSubtrees, type TreeNode } from '../src/tools/dependency-tree.js';
import { computeCadence } from '../src/tools/list-versions.js';
import { combineMomentum, computeTrendWindows } from '../src/tools/download-stats.js';
import { levelFromScore, scoreSignals, type SupplyChainResult } from '../src/tools/analyze-supply-chain.js';
import { findSafeVersions } from '../src/tools/check-vulnerabilities.js';
import type { Advisory } from '../src/lib/osv.js';

describe('diffDependencies', () => {
  it('separates added, removed and bumped dependencies', () => {
    const diff = diffDependencies(
      { keep: '^1.0.0', bump: '^1.0.0', gone: '^2.0.0' },
      { keep: '^1.0.0', bump: '^2.0.0', fresh: '^3.0.0' },
    );

    assert.deepEqual(diff.added, [{ name: 'fresh', from: null, to: '^3.0.0', change: 'added' }]);
    assert.deepEqual(diff.removed, [{ name: 'gone', from: '^2.0.0', to: null, change: 'removed' }]);
    assert.deepEqual(diff.changed, [{ name: 'bump', from: '^1.0.0', to: '^2.0.0', change: 'changed' }]);
  });

  it('treats undefined maps as empty', () => {
    const diff = diffDependencies(undefined, { a: '^1.0.0' });
    assert.equal(diff.added.length, 1);
    assert.equal(diff.removed.length, 0);

    const empty = diffDependencies(undefined, undefined);
    assert.deepEqual(empty, { added: [], removed: [], changed: [] });
  });

  it('sorts each group by name', () => {
    const diff = diffDependencies({}, { zeta: '1', alpha: '1', mid: '1' });
    assert.deepEqual(
      diff.added.map((change) => change.name),
      ['alpha', 'mid', 'zeta'],
    );
  });
});

describe('collectEdges', () => {
  it('classifies optional dependencies that also appear in dependencies', () => {
    const edges = collectEdges(
      { dependencies: { a: '^1.0.0', b: '^1.0.0' }, optionalDependencies: { b: '^1.0.0' } },
      { includeDev: false, includePeer: false },
    );
    assert.deepEqual(edges, [
      { name: 'a', range: '^1.0.0', kind: 'prod' },
      { name: 'b', range: '^1.0.0', kind: 'optional' },
    ]);
  });

  it('includes dev dependencies only when asked', () => {
    const manifest = { dependencies: { a: '^1.0.0' }, devDependencies: { d: '^1.0.0' } };
    assert.equal(collectEdges(manifest, { includeDev: false, includePeer: false }).length, 1);
    assert.equal(collectEdges(manifest, { includeDev: true, includePeer: false }).length, 2);
  });

  it('skips optional peer dependencies', () => {
    const edges = collectEdges(
      {
        peerDependencies: { required: '^1.0.0', optional: '^1.0.0' },
        peerDependenciesMeta: { optional: { optional: true } },
      },
      { includeDev: false, includePeer: true },
    );
    assert.deepEqual(
      edges.map((edge) => edge.name),
      ['required'],
    );
  });

  it('does not duplicate a peer that is already a runtime dependency', () => {
    const edges = collectEdges(
      { dependencies: { shared: '^1.0.0' }, peerDependencies: { shared: '^1.0.0' } },
      { includeDev: false, includePeer: true },
    );
    assert.equal(edges.length, 1);
    assert.equal(edges[0]?.kind, 'prod');
  });
});

describe('computeHeaviestSubtrees', () => {
  const node = (name: string, version: string, dependencies: TreeNode[] = []): TreeNode => ({
    name,
    version,
    range: '*',
    kind: 'prod',
    depth: 1,
    dependencies,
  });

  it('ranks direct dependencies by unique transitive count', () => {
    const root = node('root', '1.0.0', [
      node('heavy', '1.0.0', [node('x', '1.0.0'), node('y', '1.0.0'), node('z', '1.0.0')]),
      node('light', '1.0.0', [node('x', '1.0.0')]),
    ]);

    const heaviest = computeHeaviestSubtrees(root);
    assert.equal(heaviest[0]?.name, 'heavy');
    assert.equal(heaviest[0]?.uniqueDependencies, 4); // heavy + x + y + z
    assert.equal(heaviest[1]?.name, 'light');
  });

  it('counts exclusive dependencies separately from shared ones', () => {
    const root = node('root', '1.0.0', [
      node('a', '1.0.0', [node('shared', '1.0.0'), node('onlyA', '1.0.0')]),
      node('b', '1.0.0', [node('shared', '1.0.0')]),
    ]);

    const heaviest = computeHeaviestSubtrees(root);
    const a = heaviest.find((entry) => entry.name === 'a');
    // a, onlyA are exclusive; `shared` is not.
    assert.equal(a?.uniqueDependencies, 3);
    assert.equal(a?.exclusiveDependencies, 2);
  });

  it('returns an empty list for a leaf', () => {
    assert.deepEqual(computeHeaviestSubtrees(node('root', '1.0.0')), []);
  });
});

describe('computeCadence', () => {
  const now = new Date('2024-06-15T00:00:00Z');

  it('computes mean and median gaps', () => {
    const cadence = computeCadence(
      [
        { version: '1.0.0', publishedAt: '2024-01-01T00:00:00Z' },
        { version: '1.0.1', publishedAt: '2024-01-11T00:00:00Z' }, // +10
        { version: '1.0.2', publishedAt: '2024-01-31T00:00:00Z' }, // +20
      ],
      now,
    );
    assert.equal(cadence.averageDaysBetweenReleases, 15);
    assert.equal(cadence.medianDaysBetweenReleases, 15);
  });

  it('counts releases in the last 90 days', () => {
    const cadence = computeCadence(
      [
        { version: '1.0.0', publishedAt: '2023-01-01T00:00:00Z' },
        { version: '1.1.0', publishedAt: '2024-05-01T00:00:00Z' },
        { version: '1.2.0', publishedAt: '2024-06-01T00:00:00Z' },
      ],
      now,
    );
    assert.equal(cadence.releasesLast90Days, 2);
    assert.equal(cadence.daysSinceLastRelease, 14);
  });

  it('handles a single release', () => {
    const cadence = computeCadence([{ version: '1.0.0', publishedAt: '2024-06-01T00:00:00Z' }], now);
    assert.equal(cadence.averageDaysBetweenReleases, null);
    assert.equal(cadence.medianDaysBetweenReleases, null);
    assert.equal(cadence.daysSinceLastRelease, 14);
  });

  it('ignores entries with no publish time', () => {
    const cadence = computeCadence(
      [
        { version: '1.0.0', publishedAt: null },
        { version: '1.0.1', publishedAt: 'not-a-date' },
      ],
      now,
    );
    assert.equal(cadence.daysSinceLastRelease, null);
    assert.equal(cadence.releasesLast90Days, 0);
  });

  it('sorts unordered input before measuring gaps', () => {
    const cadence = computeCadence(
      [
        { version: '1.0.2', publishedAt: '2024-01-21T00:00:00Z' },
        { version: '1.0.0', publishedAt: '2024-01-01T00:00:00Z' },
        { version: '1.0.1', publishedAt: '2024-01-11T00:00:00Z' },
      ],
      now,
    );
    assert.equal(cadence.averageDaysBetweenReleases, 10);
  });

  it('reports lastPublishedAt as the newest real publish', () => {
    const cadence = computeCadence(
      [
        { version: '1.0.0', publishedAt: '2024-01-01T00:00:00Z' },
        { version: '1.1.0', publishedAt: '2024-05-02T00:00:00Z' },
        { version: '1.0.1', publishedAt: '2024-03-01T00:00:00Z' },
      ],
      now,
    );
    assert.equal(cadence.lastPublishedAt, '2024-05-02T00:00:00.000Z');
  });

  it('keeps lastPublishedAt and daysSinceLastRelease consistent', () => {
    // Regression: the summary once read lastPublishedAt off the packument's
    // `modified` field, which bumps when an old version is deprecated. That made
    // a dormant package look ~7 weeks fresher than its last actual release.
    const asOf = new Date('2026-07-24T12:00:00Z');
    const cadence = computeCadence(
      [
        { version: '5.6.0', publishedAt: '2025-08-17T07:27:47.572Z' },
        // A later packument `modified` (e.g. deprecating an old version) must
        // not be mistaken for a release.
        { version: '5.6.2', publishedAt: '2025-09-08T14:47:54.486Z' },
      ],
      asOf,
    );

    assert.equal(cadence.lastPublishedAt, '2025-09-08T14:47:54.486Z');
    assert.equal(cadence.daysSinceLastRelease, 319);

    // The two must describe the same instant, not merely both be present.
    const impliedDays = Math.round((asOf.getTime() - Date.parse(cadence.lastPublishedAt!)) / 86_400_000);
    assert.equal(impliedDays, cadence.daysSinceLastRelease);
  });

  it('returns a null lastPublishedAt when nothing has a publish time', () => {
    const cadence = computeCadence([{ version: '1.0.0', publishedAt: null }], now);
    assert.equal(cadence.lastPublishedAt, null);
    assert.equal(cadence.daysSinceLastRelease, null);
  });
});

describe('computeTrendWindows', () => {
  const windows = computeTrendWindows(new Date('2024-06-15T09:30:00Z'));

  it('anchors to yesterday to account for the reporting lag', () => {
    assert.equal(windows.currentWeek.end, '2024-06-14');
  });

  it('produces two adjacent, non-overlapping 7-day weeks', () => {
    assert.equal(windows.currentWeek.start, '2024-06-08');
    assert.equal(windows.previousWeek.end, '2024-06-07');
    assert.equal(windows.previousWeek.start, '2024-06-01');
  });

  it('produces two adjacent 30-day months', () => {
    assert.equal(windows.currentMonth.start, '2024-05-16');
    assert.equal(windows.currentMonth.end, '2024-06-14');
    assert.equal(windows.previousMonth.end, '2024-05-15');
    assert.equal(windows.previousMonth.start, '2024-04-16');
  });

  it('is stable across a month boundary', () => {
    const boundary = computeTrendWindows(new Date('2024-03-01T00:00:00Z'));
    assert.equal(boundary.currentWeek.end, '2024-02-29'); // leap year
    assert.equal(boundary.currentWeek.start, '2024-02-23');
  });
});

describe('combineMomentum', () => {
  it('agrees when both windows agree', () => {
    assert.equal(combineMomentum('growing', 'growing'), 'growing');
  });

  it('prefers the less noisy monthly window on disagreement', () => {
    assert.equal(combineMomentum('declining', 'growing'), 'growing');
  });

  it('falls back to whichever window has data', () => {
    assert.equal(combineMomentum('growing', 'unknown'), 'growing');
    assert.equal(combineMomentum('unknown', 'declining'), 'declining');
  });
});

describe('findSafeVersions', () => {
  const advisory = (id: string, fixedVersions: string[]): Advisory =>
    ({
      id,
      aliases: [],
      cve: null,
      summary: null,
      details: null,
      severity: 'high',
      cvssScore: null,
      cvssVector: null,
      cwes: [],
      published: null,
      modified: null,
      affectedRanges: [],
      fixedVersions,
      references: [],
    }) satisfies Advisory;

  const published = ['1.0.0', '1.1.0', '1.2.0', '2.0.0'];

  it('returns nothing when there are no advisories', () => {
    assert.deepEqual(findSafeVersions(published, []), []);
  });

  it('returns versions at or above the fix', () => {
    assert.deepEqual(findSafeVersions(published, [advisory('A', ['1.1.0'])]), ['2.0.0', '1.2.0', '1.1.0']);
  });

  it('requires a version to clear every advisory', () => {
    const safe = findSafeVersions(published, [advisory('A', ['1.1.0']), advisory('B', ['2.0.0'])]);
    assert.deepEqual(safe, ['2.0.0']);
  });

  it('returns nothing when any advisory has no published fix', () => {
    assert.deepEqual(findSafeVersions(published, [advisory('A', ['1.1.0']), advisory('B', [])]), []);
  });
});

describe('supply-chain scoring', () => {
  const baseFacts = (): SupplyChainResult['facts'] => ({
    weeklyDownloads: 5_000_000,
    maintainerCount: 4,
    maintainers: ['a', 'b', 'c', 'd'],
    lastPublisher: 'a',
    publishedAt: '2024-06-01T00:00:00Z',
    daysSincePublish: 30,
    packageAgeDays: 2000,
    totalVersions: 100,
    license: 'MIT',
    repository: 'https://github.com/a/b',
    deprecated: null,
    installScripts: {},
    allScriptNames: ['test', 'build'],
    provenance: { present: true, hasProvenance: true, hasPublishAttestation: true, predicateTypes: ['provenance'] },
    integrity: { hasIntegrity: true, hasRegistrySignature: true },
    typosquatMatches: [],
    knownVulnerabilities: { count: 0, highestSeverity: null },
  });

  const scoreOf = (facts: SupplyChainResult['facts'], name = 'safe-package'): number =>
    Math.max(
      0,
      scoreSignals(facts, name).reduce((sum, signal) => sum + signal.weight, 0),
    );

  it('rates a healthy, well-adopted package as low risk', () => {
    assert.equal(levelFromScore(scoreOf(baseFacts())), 'low');
  });

  it('flags install scripts as the heaviest single signal', () => {
    const facts = { ...baseFacts(), installScripts: { postinstall: 'node build.js' } };
    const signal = scoreSignals(facts, 'x').find((entry) => entry.id === 'install-scripts');
    assert.equal(signal?.severity, 'high');
    assert.ok(signal?.detail.includes('node build.js'));
  });

  it('escalates an unknown package with a near-miss name to high risk', () => {
    const facts: SupplyChainResult['facts'] = {
      ...baseFacts(),
      weeklyDownloads: 30,
      maintainerCount: 1,
      maintainers: ['nobody'],
      packageAgeDays: 3,
      daysSincePublish: 1,
      license: null,
      repository: null,
      provenance: { present: false, hasProvenance: false, hasPublishAttestation: false, predicateTypes: [] },
      integrity: { hasIntegrity: true, hasRegistrySignature: false },
      typosquatMatches: [{ target: 'lodash', distance: 1, technique: 'edit-distance' }],
    };
    assert.equal(levelFromScore(scoreOf(facts, 'lodahs')), 'high');
  });

  it('does not accuse a popular package of typosquatting its neighbour', () => {
    const facts: SupplyChainResult['facts'] = {
      ...baseFacts(),
      typosquatMatches: [{ target: 'vue', distance: 1, technique: 'edit-distance' }],
    };
    const signals = scoreSignals(facts, 'vuex');
    const typo = signals.find((signal) => signal.id.includes('typosquat') || signal.id.includes('similar-name'));
    assert.equal(typo?.id, 'similar-name-established');
    assert.equal(typo?.weight, 0);
    assert.equal(levelFromScore(scoreOf(facts, 'vuex')), 'low');
  });

  it('weights a single maintainer lower when the package is heavily adopted', () => {
    const popular = { ...baseFacts(), maintainerCount: 1, maintainers: ['solo'] };
    const obscure = { ...popular, weeklyDownloads: 500 };
    const weightOf = (facts: SupplyChainResult['facts']): number =>
      scoreSignals(facts, 'x').find((signal) => signal.id === 'single-maintainer')?.weight ?? 0;
    assert.ok(weightOf(popular) < weightOf(obscure));
  });

  it('treats a missing license as a serious finding', () => {
    const signals = scoreSignals({ ...baseFacts(), license: null }, 'x');
    assert.equal(signals.find((signal) => signal.id === 'no-license')?.severity, 'high');
  });

  it('records provenance as a negative-weight mitigation', () => {
    const signal = scoreSignals(baseFacts(), 'x').find((entry) => entry.id === 'has-provenance');
    assert.ok(signal && signal.weight < 0);
  });

  it('maps scores onto the documented thresholds', () => {
    assert.equal(levelFromScore(0), 'low');
    assert.equal(levelFromScore(19), 'low');
    assert.equal(levelFromScore(20), 'medium');
    assert.equal(levelFromScore(49), 'medium');
    assert.equal(levelFromScore(50), 'high');
  });
});
