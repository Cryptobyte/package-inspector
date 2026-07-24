import { z } from 'zod';
import { getPackument, getVersionManifest, resolveVersion } from '../lib/npm.js';
import { getBundleSize, getInstallSize, type BundleSize, type InstallSize } from '../lib/sizes.js';
import { optional } from '../lib/errors.js';
import { humanBytes, humanCount, humanSeconds, lines } from '../lib/format.js';
import { toolText } from '../lib/response.js';
import { defineTool, packageNameSchema, versionSchema, type JsonSchemaObject } from './types.js';

const input = z.object({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(128).optional()
});

export type PackageSizeInput = z.infer<typeof input>;

const inputSchema: JsonSchemaObject = {
  type: 'object',
  properties: { name: packageNameSchema, version: versionSchema },
  required: ['name'],
  additionalProperties: false
};

interface SizeField {
  bytes: number | null;
  human: string;
}

function size(bytes: number | null): SizeField {
  return { bytes, human: humanBytes(bytes) };
}

export interface PackageSizeResult {
  name: string;
  requestedVersion: string;
  resolvedVersion: string;
  tarball: {
    unpackedSize: SizeField;
    fileCount: number | null;
  };

  install: {
    available: boolean;
    publishSize: SizeField;
    publishFiles: number | null;
    installSize: SizeField;
    installFiles: number | null;
    source: string;
  };

  bundle: {
    available: boolean;
    minified: SizeField;
    minifiedGzipped: SizeField;
    dependencyCount: number | null;
    hasSideEffects: boolean | null;
    treeShakeable: boolean | null;
    hasESModule: boolean;
    heaviestDependencies: Array<{ name: string; approximateSize: number; human: string }>;
    downloadTime: { slow3g: string; emerging4g: string; slow3gSeconds: number; emerging4gSeconds: number } | null;
    source: string;
  };

  notes: string[];
}

function buildSummary(result: PackageSizeResult): string {
  const bundleLine = result.bundle.available
    ? `Bundle (min+gzip): ${result.bundle.minifiedGzipped.human} · minified: ${result.bundle.minified.human} · ${
        result.bundle.dependencyCount ?? '?'
      } dependencies`
    : 'Bundle size: unavailable (bundlephobia could not build this package).';

  const installLine = result.install.available
    ? `Install footprint: ${result.install.installSize.human} on disk (${humanCount(
        result.install.installFiles,
      )} files), ${result.install.publishSize.human} downloaded`
    : 'Install footprint: unavailable (packagephobia has no data for this version).';

  const shakeable =
    result.bundle.treeShakeable === null
      ? null
      : result.bundle.treeShakeable
        ? 'Declares `sideEffects: false` — safely tree-shakeable.'
        : '⚠️ Declares side effects — bundlers cannot tree-shake it away.';

  const heaviest =
    result.bundle.heaviestDependencies.length > 0
      ? `Heaviest dependencies: ${result.bundle.heaviestDependencies
          .map((entry) => `${entry.name} (${entry.human})`)
          .join(', ')}`
      : null;

  return lines(
    `${result.name}@${result.resolvedVersion} size report`,
    '',
    installLine,
    bundleLine,
    result.tarball.unpackedSize.bytes !== null
      ? `Tarball unpacked (this package alone): ${result.tarball.unpackedSize.human} across ${humanCount(
          result.tarball.fileCount,
        )} files`
      : null,
    result.bundle.downloadTime
      ? `Download time for the bundle: ${result.bundle.downloadTime.slow3g} on slow 3G, ${result.bundle.downloadTime.emerging4g} on 4G`
      : null,
    shakeable,
    heaviest
  );
}

function shapeBundle(bundle: BundleSize | null): PackageSizeResult['bundle'] {
  if (!bundle) {
    return {
      available: false,
      minified: size(null),
      minifiedGzipped: size(null),
      dependencyCount: null,
      hasSideEffects: null,
      treeShakeable: null,
      hasESModule: false,
      heaviestDependencies: [],
      downloadTime: null,
      source: 'https://bundlephobia.com'
    };
  }

  return {
    available: true,
    minified: size(bundle.size),
    minifiedGzipped: size(bundle.gzip),
    dependencyCount: bundle.dependencyCount,
    hasSideEffects: bundle.hasSideEffects,
    treeShakeable: bundle.treeShakeable,
    hasESModule: bundle.hasJSModule || bundle.isModuleType,
    heaviestDependencies: bundle.heaviestDependencies.map((entry) => ({
      ...entry,
      human: humanBytes(entry.approximateSize),
    })),
    downloadTime: bundle.downloadTime
      ? {
          slow3g: humanSeconds(bundle.downloadTime.slow3gSeconds),
          emerging4g: humanSeconds(bundle.downloadTime.emerging4gSeconds),
          slow3gSeconds: bundle.downloadTime.slow3gSeconds,
          emerging4gSeconds: bundle.downloadTime.emerging4gSeconds,
        }
      : null,
    source: 'https://bundlephobia.com'
  };
}

function shapeInstall(install: InstallSize | null): PackageSizeResult['install'] {
  return {
    available: install !== null,
    publishSize: size(install?.publishBytes ?? null),
    publishFiles: install?.publishFiles ?? null,
    installSize: size(install?.installBytes ?? null),
    installFiles: install?.installFiles ?? null,
    source: 'https://packagephobia.com'
  };
}

export async function packageSize(args: PackageSizeInput): Promise<PackageSizeResult> {
  const packument = await getPackument(args.name);
  const resolved = resolveVersion(packument, args.version);
  const [manifest, installResult, bundleResult] = await Promise.all([
    getVersionManifest(packument.name, resolved.version),
    optional('packagephobia', () => getInstallSize(packument.name, resolved.version)),
    optional('bundlephobia', () => getBundleSize(packument.name, resolved.version))
  ]);

  const notes = [installResult.note, bundleResult.note].filter((note): note is string => note !== null);

  return {
    name: packument.name,
    requestedVersion: resolved.requested,
    resolvedVersion: resolved.version,
    tarball: {
      unpackedSize: size(manifest.dist?.unpackedSize ?? null),
      fileCount: manifest.dist?.fileCount ?? null,
    },
    install: shapeInstall(installResult.value),
    bundle: shapeBundle(bundleResult.value),
    notes
  };
}

export const packageSizeTool = defineTool({
  name: 'package_size',
  title: 'Measure package size',
  description:
    'Measure what a package actually costs: install footprint from packagephobia (bytes downloaded and bytes on disk ' +
    'in node_modules, including dependencies) and browser bundle cost from bundlephobia (minified and min+gzip size, ' +
    'dependency count, whether it is tree-shakeable, and download-time estimates on slow 3G/4G). Use this for "how big ' +
    'is X", "will X bloat my bundle", or when comparing candidate libraries by weight. Degrades gracefully when a ' +
    'size service has no data.',
  inputSchema,
  input,
  handler: async (args) => {
    const result = await packageSize(args);
    
    return toolText(buildSummary(result), result, result.notes);
  }
});
