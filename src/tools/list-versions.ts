import { z } from 'zod';
import { getPackument, resolveVersion } from '../lib/npm.js';
import { isPrerelease, sortDescending } from '../lib/semver.js';
import { daysBetween, lines, plural, relativeTime } from '../lib/format.js';
import { toolText } from '../lib/response.js';
import { defineTool, packageNameSchema, type JsonSchemaObject } from './types.js';

const input = z.object({
  name: z.string().min(1).max(214),
  limit: z.number().int().min(1).max(200).optional().default(30),
  includePrerelease: z.boolean().optional().default(false)
});

export type ListVersionsInput = z.infer<typeof input>;

const inputSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    name: packageNameSchema,
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 200,
      default: 30,
      description: 'How many versions to return, newest first. Defaults to 30.'
    },
    includePrerelease: {
      type: 'boolean',
      default: false,
      description: 'Include prerelease versions (1.0.0-beta.1). Defaults to false.'
    }
  },
  required: ['name'],
  additionalProperties: false
};

export interface VersionEntry {
  version: string;
  publishedAt: string | null;
  publishedRelative: string;
  isLatest: boolean;
  isPrerelease: boolean;
  deprecated: string | null;
  daysSincePrevious: number | null;
}

export interface ReleaseCadence {
  totalVersions: number;
  stableVersions: number;
  prereleaseVersions: number;
  deprecatedVersions: number;
  firstPublishedAt: string | null;
  lastPublishedAt: string | null;
  averageDaysBetweenReleases: number | null;
  medianDaysBetweenReleases: number | null;
  releasesLast90Days: number;
  daysSinceLastRelease: number | null;
}

/**
 * Derives release cadence from a version -> publish-time map.
 *
 * `lastPublishedAt` is returned from here rather than read off the packument's
 * `modified` field: `modified` bumps on *any* packument edit, including
 * deprecating an old version, so it can be weeks newer than the last actual
 * release and makes a dormant package look freshly maintained. Deriving it from
 * the same sorted timeline as `daysSinceLastRelease` makes the two agree by
 * construction.
 */
export function computeCadence(
  timeline: ReadonlyArray<{ version: string; publishedAt: string | null }>,
  now: Date = new Date(),
): Pick<
  ReleaseCadence,
  | 'averageDaysBetweenReleases'
  | 'medianDaysBetweenReleases'
  | 'releasesLast90Days'
  | 'daysSinceLastRelease'
  | 'lastPublishedAt'
> {
  const dated = timeline
    .filter((entry): entry is { version: string; publishedAt: string } => entry.publishedAt !== null)
    .map((entry) => ({ version: entry.version, at: new Date(entry.publishedAt).getTime() }))
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => a.at - b.at);

  if (dated.length === 0) {
    return {
      averageDaysBetweenReleases: null,
      medianDaysBetweenReleases: null,
      releasesLast90Days: 0,
      daysSinceLastRelease: null,
      lastPublishedAt: null
    };
  }

  const gaps: number[] = [];

  for (let i = 1; i < dated.length; i++) {
    gaps.push((dated[i]!.at - dated[i - 1]!.at) / 86_400_000);
  }

  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const median =
    sortedGaps.length === 0
      ? null
      : sortedGaps.length % 2 === 1
        ? sortedGaps[(sortedGaps.length - 1) / 2]!
        : (sortedGaps[sortedGaps.length / 2 - 1]! + sortedGaps[sortedGaps.length / 2]!) / 2;

  const cutoff = now.getTime() - 90 * 86_400_000;
  const last = dated[dated.length - 1]!;

  return {
    averageDaysBetweenReleases: gaps.length === 0 ? null : Number((gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length).toFixed(1)),
    medianDaysBetweenReleases: median === null ? null : Number(median.toFixed(1)),
    releasesLast90Days: dated.filter((entry) => entry.at >= cutoff).length,
    daysSinceLastRelease: Math.max(0, Math.round((now.getTime() - last.at) / 86_400_000)),
    lastPublishedAt: new Date(last.at).toISOString()
  };
}

export interface ListVersionsResult {
  name: string;
  latestVersion: string | null;
  /**
   * When the `latest` version itself was published. Distinct from
   * `cadence.lastPublishedAt`, which is the most recent publish of *any*
   * version — they differ when a maintainer backports to an older line.
   */
  latestPublishedAt: string | null;
  distTags: Record<string, string>;
  returned: number;
  truncated: boolean;
  versions: VersionEntry[];
  cadence: ReleaseCadence;
}

function buildSummary(result: ListVersionsResult): string {
  const { cadence } = result;
  
  const rhythm =
    cadence.medianDaysBetweenReleases === null
      ? 'release cadence unknown'
      : cadence.medianDaysBetweenReleases < 0.5
        ? 'often several releases a day (median gap under 12 hours)'
        : `a release roughly every ${plural(cadence.medianDaysBetweenReleases, 'day')} (median)`;

  const activity =
    cadence.daysSinceLastRelease === null
      ? ''
      : cadence.daysSinceLastRelease > 365
        ? ' ⚠️ No release in over a year — this package looks dormant.'
        : cadence.releasesLast90Days > 0
          ? ` Actively maintained: ${plural(cadence.releasesLast90Days, 'release')} in the last 90 days.`
          : ' No releases in the last 90 days.';

  const head = result.versions
    .slice(0, 5)
    .map((entry) => {
      const flags = [
        entry.isLatest ? 'latest' : null,
        entry.isPrerelease ? 'prerelease' : null,
        entry.deprecated ? 'DEPRECATED' : null,
      ].filter(Boolean);
      return `  ${entry.version}  ${entry.publishedAt ?? 'unknown date'}${flags.length ? `  [${flags.join(', ')}]` : ''}`;
    })
    .join('\n');

  return lines(
    `${result.name}: ${cadence.totalVersions} versions published, ${rhythm}.${activity}`,
    `Latest: ${result.latestVersion ?? 'unknown'} (${relativeTime(result.latestPublishedAt)})`,
    // Only worth saying when a backport to an older line is the newest publish.
    cadence.lastPublishedAt && cadence.lastPublishedAt !== result.latestPublishedAt
      ? `Most recent publish of any version: ${relativeTime(cadence.lastPublishedAt)} (an older release line).`
      : null,
    cadence.deprecatedVersions > 0 ? `${cadence.deprecatedVersions} version(s) are deprecated.` : null,
    '',
    `Most recent ${Math.min(5, result.versions.length)} of ${result.returned} returned:`,
    head
  );
}

export async function listVersions(args: ListVersionsInput): Promise<ListVersionsResult> {
  const packument = await getPackument(args.name);
  const latest = packument.distTags.latest ?? resolveVersion(packument).version;

  const all = sortDescending(packument.versions);
  const filtered = args.includePrerelease ? all : all.filter((version) => !isPrerelease(version));
  const pool = filtered.length > 0 ? filtered : all;
  const selected = pool.slice(0, args.limit);

  const versions: VersionEntry[] = selected.map((version, index) => {
    const publishedAt = packument.time[version] ?? null;
    const next = selected[index + 1];
    const previousPublishedAt = next ? (packument.time[next] ?? null) : null;

    return {
      version,
      publishedAt,
      publishedRelative: relativeTime(publishedAt),
      isLatest: version === latest,
      isPrerelease: isPrerelease(version),
      deprecated: packument.deprecatedVersions[version] ?? null,
      daysSincePrevious: publishedAt && previousPublishedAt ? daysBetween(previousPublishedAt, publishedAt) : null
    };
  });

  const timeline = packument.versions.map((version) => ({
    version,
    publishedAt: packument.time[version] ?? null,
  }));

  return {
    name: packument.name,
    latestVersion: packument.distTags.latest ?? null,
    latestPublishedAt: latest ? (packument.time[latest] ?? null) : null,
    distTags: packument.distTags,
    returned: versions.length,
    truncated: pool.length > versions.length,
    versions,
    cadence: {
      totalVersions: packument.versions.length,
      stableVersions: packument.versions.filter((version) => !isPrerelease(version)).length,
      prereleaseVersions: packument.versions.filter((version) => isPrerelease(version)).length,
      deprecatedVersions: Object.keys(packument.deprecatedVersions).length,
      firstPublishedAt: packument.time.created ?? null,
      // lastPublishedAt comes from computeCadence, derived from real publish
      // times — never from the packument's `modified` field.
      ...computeCadence(timeline)
    }
  };
}

export const listVersionsTool = defineTool({
  name: 'list_versions',
  title: 'List package versions',
  description:
    'List an npm package\'s recent versions newest-first with publish dates, marking the latest version and any ' +
    'deprecated ones, plus release-cadence stats (total versions, average/median days between releases, releases in ' +
    'the last 90 days). Use this to answer "what versions exist", "when was the last release", "is this still ' +
    'actively maintained", or to find a version published before/after a given date.',
  inputSchema,
  input,
  handler: async (args) => {
    const result = await listVersions(args);
    
    return toolText(buildSummary(result), result);
  }
});
