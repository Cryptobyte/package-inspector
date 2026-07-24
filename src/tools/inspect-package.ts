import { z } from 'zod';
import { optional } from '../lib/errors.js';
import {
  getDownloadPoint,
  getPackument,
  getVersionManifest,
  normalizeLicense,
  normalizePerson,
  resolveVersion,
  shipsOwnTypes,
  typesPackageName,
  type Packument,
  type VersionManifest,

} from '../lib/npm.js';

import { humanCount, lines, normalizeRepositoryUrl, relativeTime, truncate } from '../lib/format.js';
import { toolText } from '../lib/response.js';
import { defineTool, packageNameSchema, versionSchema, type JsonSchemaObject } from './types.js';

const input = z.object({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(128).optional()
});

export type InspectPackageInput = z.infer<typeof input>;

const inputSchema: JsonSchemaObject = {
  type: 'object',
  properties: { name: packageNameSchema, version: versionSchema },
  required: ['name'],
  additionalProperties: false
};

export interface InspectPackageResult {
  name: string;
  requestedVersion: string;
  resolvedVersion: string;
  latestVersion: string | null;
  description: string | null;
  license: string | null;
  author: string | null;
  maintainerCount: number;
  maintainers: string[];
  homepage: string | null;
  repository: string | null;
  distTags: Record<string, string>;
  deprecated: { isDeprecated: boolean; message: string | null; packageDeprecated: boolean };
  publishedAt: string | null;
  publishedRelative: string;
  latestPublishedAt: string | null;
  firstPublishedAt: string | null;
  totalVersions: number;
  engines: Record<string, string> | null;
  types: { shipsOwnTypes: boolean; typesPackage: string | null; typesPackageExists: boolean | null };
  weeklyDownloads: number | null;
  keywords: string[];
  dependencyCounts: { dependencies: number; devDependencies: number; peerDependencies: number; optionalDependencies: number };
  hasInstallScript: boolean;
  unpackedSizeBytes: number | null;
  fileCount: number | null;
  tarball: string | null;
}

function buildSummary(result: InspectPackageResult): string {
  const headline = `${result.name}@${result.resolvedVersion}${
    result.resolvedVersion === result.latestVersion ? ' (latest)' : ` (latest is ${result.latestVersion ?? 'unknown'})`
  }`;

  const warnings: string[] = [];
  if (result.deprecated.isDeprecated) {
    warnings.push(`⚠️ DEPRECATED: ${result.deprecated.message ?? 'no message given'}`);
  }

  if (!result.license) {
    warnings.push('⚠️ No license field declared.');
  }

  const typing = result.types.shipsOwnTypes
    ? 'ships its own TypeScript types'
    : result.types.typesPackageExists
      ? `no bundled types (use ${result.types.typesPackage})`
      : 'no TypeScript types';

  return lines(
    headline,
    result.description ? `${result.description}` : null,
    '',
    ...warnings,
    warnings.length > 0 ? '' : null,
    `License: ${result.license ?? 'none declared'} · Maintainers: ${result.maintainerCount} · ${typing}`,
    `Published: ${result.publishedAt ?? 'unknown'} (${result.publishedRelative}) · ${result.totalVersions} versions total`,
    `Weekly downloads: ${humanCount(result.weeklyDownloads)}`,
    `Dependencies: ${result.dependencyCounts.dependencies} runtime, ${result.dependencyCounts.peerDependencies} peer`,
    result.engines?.node ? `Requires Node ${result.engines.node}` : null,
    result.repository ? `Repository: ${result.repository}` : null,
    result.hasInstallScript ? '⚠️ Runs an install script (preinstall/install/postinstall).' : null
  );
}

function countRecord(record: Record<string, string> | undefined): number {
  return record ? Object.keys(record).length : 0;
}

function pickPublishTime(packument: Packument, version: string): string | null {
  return packument.time[version] ?? null;
}

export async function inspectPackage(args: InspectPackageInput): Promise<InspectPackageResult> {
  const packument = await getPackument(args.name);
  const resolved = resolveVersion(packument, args.version);
  const manifest: VersionManifest = await getVersionManifest(packument.name, resolved.version);

  const ownTypes = shipsOwnTypes(manifest);
  const typesPackage = ownTypes ? null : typesPackageName(packument.name);

  const [downloads, typesProbe] = await Promise.all([
    optional('npm downloads', () => getDownloadPoint(packument.name, 'last-week')),
    typesPackage
      ? optional('npm registry', () => getPackument(typesPackage).then(() => true))
      : Promise.resolve({ value: null, note: null } as const)
  ]);

  const latest = packument.distTags.latest ?? null;
  const versionDeprecation = packument.deprecatedVersions[resolved.version] ?? null;
  const packageDeprecated = latest !== null && packument.deprecatedVersions[latest] !== undefined;

  const publishedAt = pickPublishTime(packument, resolved.version);

  return {
    name: packument.name,
    requestedVersion: resolved.requested,
    resolvedVersion: resolved.version,
    latestVersion: latest,
    description: truncate(manifest.description ?? packument.description, 400),
    license: normalizeLicense(manifest.license ?? packument.license),
    author: normalizePerson(manifest.author ?? packument.author),
    maintainerCount: (manifest.maintainers ?? packument.maintainers).length,
    maintainers: (manifest.maintainers ?? packument.maintainers).map((person) => person.name).filter(Boolean),
    homepage: manifest.homepage ?? packument.homepage ?? null,
    repository: normalizeRepositoryUrl(manifest.repository ?? packument.repository),
    distTags: packument.distTags,
    deprecated: {
      isDeprecated: versionDeprecation !== null,
      message: versionDeprecation,
      packageDeprecated
    },
    publishedAt,
    publishedRelative: relativeTime(publishedAt),
    latestPublishedAt: latest ? pickPublishTime(packument, latest) : null,
    firstPublishedAt: packument.time.created ?? null,
    totalVersions: packument.versions.length,
    engines: manifest.engines ?? null,
    types: {
      shipsOwnTypes: ownTypes,
      typesPackage,
      typesPackageExists: typesProbe.value === true ? true : typesPackage ? false : null
    },
    weeklyDownloads: downloads.value?.downloads ?? null,
    keywords: manifest.keywords ?? packument.keywords,
    dependencyCounts: {
      dependencies: countRecord(manifest.dependencies),
      devDependencies: countRecord(manifest.devDependencies),
      peerDependencies: countRecord(manifest.peerDependencies),
      optionalDependencies: countRecord(manifest.optionalDependencies)
    },
    hasInstallScript:
      manifest.hasInstallScript === true ||
      ['preinstall', 'install', 'postinstall'].some((key) => Boolean(manifest.scripts?.[key])),
    unpackedSizeBytes: manifest.dist?.unpackedSize ?? null,
    fileCount: manifest.dist?.fileCount ?? null,
    tarball: manifest.dist?.tarball ?? null
  };
}

export const inspectPackageTool = defineTool({
  name: 'inspect_package',
  title: 'Inspect npm package',
  description:
    'Get a complete overview of an npm package: description, resolved version, license, maintainers, repository, ' +
    'dist-tags, deprecation status, publish date, Node engine requirements, TypeScript types, and weekly downloads. ' +
    'Use this first whenever a user asks "what is X", "should I use X", "is X maintained", or wants general facts ' +
    'about a package before installing it.',
  inputSchema,
  input,
  handler: async (args) => {
    const result = await inspectPackage(args);

    return toolText(buildSummary(result), result);
  }
});
