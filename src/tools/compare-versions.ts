import { z } from 'zod';
import { getPackument, getVersionManifest, normalizeLicense, resolveVersion } from '../lib/npm.js';
import { getBundleSize } from '../lib/sizes.js';
import { optional } from '../lib/errors.js';
import { diffType, isLikelyBreaking, type ReleaseType } from '../lib/semver.js';
import { daysBetween, humanBytes, lines, percentChange, plural } from '../lib/format.js';
import { toolText } from '../lib/response.js';
import { defineTool, packageNameSchema, versionSchema, type JsonSchemaObject } from './types.js';

const input = z.object({
  name: z.string().min(1).max(214),
  from: z.string().min(1).max(128),
  to: z.string().min(1).max(128)
});

export type CompareVersionsInput = z.infer<typeof input>;

const inputSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    name: packageNameSchema,
    from: { ...versionSchema, description: 'The older version or dist-tag to compare from, e.g. "0.27.2".' },
    to: { ...versionSchema, description: 'The newer version or dist-tag to compare to, e.g. "1.7.0" or "latest".' },
  },
  required: ['name', 'from', 'to'],
  additionalProperties: false
};

export interface DependencyChange {
  name: string;
  from: string | null;
  to: string | null;
  change: 'added' | 'removed' | 'changed';
}

export interface DependencyDiff {
  added: DependencyChange[];
  removed: DependencyChange[];
  changed: DependencyChange[];
}

export function diffDependencies(
  from: Record<string, string> | undefined,
  to: Record<string, string> | undefined,
): DependencyDiff {
  const before = from ?? {};
  const after = to ?? {};

  const added: DependencyChange[] = [];
  const removed: DependencyChange[] = [];
  const changed: DependencyChange[] = [];

  for (const [name, range] of Object.entries(after)) {
    const previous = before[name];

    if (previous === undefined) {
      added.push({ name, from: null, to: range, change: 'added' });

    } else if (previous !== range) {
      changed.push({ name, from: previous, to: range, change: 'changed' });
    }
  }

  for (const [name, range] of Object.entries(before)) {
    if (after[name] === undefined) {
      removed.push({ name, from: range, to: null, change: 'removed' });
    }
  }

  const byName = (a: DependencyChange, b: DependencyChange): number => a.name.localeCompare(b.name);

  return { 
    added: added.sort(byName), 
    removed: removed.sort(byName), 
    changed: changed.sort(byName) 
  };
}

function countDiff(diff: DependencyDiff): number {
  return diff.added.length + diff.removed.length + diff.changed.length;
}

export interface CompareVersionsResult {
  name: string;
  from: { requested: string; version: string; publishedAt: string | null; deprecated: string | null };
  to: { requested: string; version: string; publishedAt: string | null; deprecated: string | null };
  releaseType: ReleaseType | null;
  likelyBreaking: boolean;
  breakingReason: string | null;
  daysBetweenReleases: number | null;
  versionsBetween: number;
  dependencies: DependencyDiff;
  peerDependencies: DependencyDiff;
  optionalDependencies: DependencyDiff;
  dependencyCountDelta: { from: number; to: number; delta: number };
  sizeDelta: {
    available: boolean;
    fromGzip: number | null;
    toGzip: number | null;
    deltaBytes: number | null;
    deltaHuman: string | null;
    percentChange: number | null;
  };

  engineChange: { from: Record<string, string> | null; to: Record<string, string> | null; changed: boolean };
  licenseChange: { from: string | null; to: string | null; changed: boolean };
  notes: string[];
}

function formatChangeList(changes: readonly DependencyChange[], verb: string, limit = 12): string | null {
  if (changes.length === 0) return null;

  const shown = changes.slice(0, limit).map((change) => {
    if (change.change === 'added') return `  + ${change.name}@${change.to}`;
    if (change.change === 'removed') return `  - ${change.name}@${change.from}`;
    return `  ~ ${change.name}: ${change.from} → ${change.to}`;
  });

  const more = changes.length > limit ? `\n  … and ${changes.length - limit} more` : '';

  return `${verb} (${changes.length}):\n${shown.join('\n')}${more}`;
}

function buildSummary(result: CompareVersionsResult): string {
  const verdict = result.likelyBreaking
    ? `⚠️ ${result.releaseType} bump — likely breaking. ${result.breakingReason ?? ''}`
    : `${result.releaseType ?? 'unknown'} bump — should be backwards compatible under semver.`;

  const gap =
    result.daysBetweenReleases === null
      ? null
      : `${plural(Math.abs(result.daysBetweenReleases), 'day')} apart${
          result.versionsBetween > 0 ? `, with ${plural(result.versionsBetween, 'release')} in between` : ''
        }.`;

  const sizeLine = result.sizeDelta.available
    ? `Bundle (min+gzip): ${humanBytes(result.sizeDelta.fromGzip)} → ${humanBytes(result.sizeDelta.toGzip)} (${
        result.sizeDelta.deltaBytes !== null && result.sizeDelta.deltaBytes >= 0 ? '+' : ''
      }${result.sizeDelta.deltaHuman}, ${result.sizeDelta.percentChange !== null ? `${result.sizeDelta.percentChange > 0 ? '+' : ''}${result.sizeDelta.percentChange}%` : 'n/a'})`
    : 'Bundle size comparison unavailable.';

  const totalChanges = countDiff(result.dependencies);

  return lines(
    `${result.name}: ${result.from.version} → ${result.to.version}`,
    verdict,
    gap,
    '',
    `Runtime dependencies: ${result.dependencyCountDelta.from} → ${result.dependencyCountDelta.to} (${
      result.dependencyCountDelta.delta >= 0 ? '+' : ''
    }${result.dependencyCountDelta.delta}), ${totalChanges} change${totalChanges === 1 ? '' : 's'}`,
    formatChangeList(result.dependencies.added, 'Added'),
    formatChangeList(result.dependencies.removed, 'Removed'),
    formatChangeList(result.dependencies.changed, 'Bumped'),
    countDiff(result.peerDependencies) > 0
      ? `Peer dependency changes: ${countDiff(result.peerDependencies)} (see JSON)`
      : null,
    '',
    sizeLine,
    result.engineChange.changed
      ? `⚠️ Engine requirements changed: ${JSON.stringify(result.engineChange.from)} → ${JSON.stringify(result.engineChange.to)}`
      : null,
    result.licenseChange.changed
      ? `⚠️ License changed: ${result.licenseChange.from ?? 'none'} → ${result.licenseChange.to ?? 'none'}`
      : null,
    result.to.deprecated ? `⚠️ Target version is deprecated: ${result.to.deprecated}` : null
  );
}

export async function compareVersions(args: CompareVersionsInput): Promise<CompareVersionsResult> {
  const packument = await getPackument(args.name);
  const fromResolved = resolveVersion(packument, args.from);
  const toResolved = resolveVersion(packument, args.to);

  const [fromManifest, toManifest] = await Promise.all([
    getVersionManifest(packument.name, fromResolved.version),
    getVersionManifest(packument.name, toResolved.version)
  ]);

  const [fromBundle, toBundle] = await Promise.all([
    optional('bundlephobia', () => getBundleSize(packument.name, fromResolved.version)),
    optional('bundlephobia', () => getBundleSize(packument.name, toResolved.version))
  ]);

  const fromPublished = packument.time[fromResolved.version] ?? null;
  const toPublished = packument.time[toResolved.version] ?? null;

  const releaseType = diffType(fromResolved.version, toResolved.version);
  const likelyBreaking = isLikelyBreaking(fromResolved.version, toResolved.version);
  const breakingReason = !likelyBreaking
    ? null
    : releaseType === 'major'
      ? 'Major version bumps signal intentional breaking changes — check the changelog.'
      : 'Pre-1.0 package: npm treats a 0.x minor bump as breaking, and ^0.x ranges will not pick it up.';

  const versionsBetween =
    fromPublished && toPublished
      ? packument.versions.filter((version) => {
          const at = packument.time[version];
          if (!at) return false;
          const time = new Date(at).getTime();
          const low = Math.min(new Date(fromPublished).getTime(), new Date(toPublished).getTime());
          const high = Math.max(new Date(fromPublished).getTime(), new Date(toPublished).getTime());
          return time > low && time < high;
        }).length
      : 0;

  const fromGzip = fromBundle.value?.gzip ?? null;
  const toGzip = toBundle.value?.gzip ?? null;
  const deltaBytes = fromGzip !== null && toGzip !== null ? toGzip - fromGzip : null;

  const fromEngines = fromManifest.engines ?? null;
  const toEngines = toManifest.engines ?? null;
  const fromLicense = normalizeLicense(fromManifest.license);
  const toLicense = normalizeLicense(toManifest.license);

  const notes = [fromBundle.note, toBundle.note].filter((note): note is string => note !== null);

  return {
    name: packument.name,
    from: {
      requested: fromResolved.requested,
      version: fromResolved.version,
      publishedAt: fromPublished,
      deprecated: packument.deprecatedVersions[fromResolved.version] ?? null
    },
    to: {
      requested: toResolved.requested,
      version: toResolved.version,
      publishedAt: toPublished,
      deprecated: packument.deprecatedVersions[toResolved.version] ?? null
    },
    releaseType,
    likelyBreaking,
    breakingReason,
    daysBetweenReleases: fromPublished && toPublished ? daysBetween(fromPublished, toPublished) : null,
    versionsBetween,
    dependencies: diffDependencies(fromManifest.dependencies, toManifest.dependencies),
    peerDependencies: diffDependencies(fromManifest.peerDependencies, toManifest.peerDependencies),
    optionalDependencies: diffDependencies(fromManifest.optionalDependencies, toManifest.optionalDependencies),
    dependencyCountDelta: {
      from: Object.keys(fromManifest.dependencies ?? {}).length,
      to: Object.keys(toManifest.dependencies ?? {}).length,
      delta: Object.keys(toManifest.dependencies ?? {}).length - Object.keys(fromManifest.dependencies ?? {}).length
    },
    sizeDelta: {
      available: deltaBytes !== null,
      fromGzip,
      toGzip,
      deltaBytes,
      deltaHuman: deltaBytes === null ? null : humanBytes(Math.abs(deltaBytes)),
      percentChange: fromGzip !== null && toGzip !== null ? percentChange(fromGzip, toGzip) : null
    },
    engineChange: {
      from: fromEngines,
      to: toEngines,
      changed: JSON.stringify(fromEngines) !== JSON.stringify(toEngines)
    },
    licenseChange: { from: fromLicense, to: toLicense, changed: fromLicense !== toLicense },
    notes
  };
}

export const compareVersionsTool = defineTool({
  name: 'compare_versions',
  title: 'Compare two versions',
  description:
    'Diff two published versions of the same package: dependencies added, removed and version-bumped; bundle size ' +
    'delta; days and releases between them; engine and license changes; and a semver-based breaking-change verdict ' +
    '(major bumps, and any 0.x minor bump, are flagged as likely breaking). Use this for "what changed between X and ' +
    'Y", "is upgrading X safe", or "why did my bundle grow after upgrading".',
  inputSchema,
  input,
  handler: async (args) => {
    const result = await compareVersions(args);

    return toolText(buildSummary(result), result, result.notes);
  }
});
