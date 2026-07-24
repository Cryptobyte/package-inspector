import { z } from 'zod';
import { getPackument, getVersionManifest, resolveVersion } from '../lib/npm.js';
import { getBundleSize, type BundleSize } from '../lib/sizes.js';
import { estimateInstallSize, type InstallSizeEstimate } from '../lib/install-size.js';
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

  /**
   * Install footprint on disk, derived from npm registry metadata alone — no
   * third-party size service is involved. Named `estimatedInstall` rather than
   * `install` because it is a reconstruction, not a measurement: see `method`
   * and `caveats` on the object itself.
   */
  estimatedInstall: {
    totalSize: SizeField;
    totalFiles: number | null;
    selfSize: SizeField;
    optionalSize: SizeField;
    packageCount: number;
    uniqueNames: number;
    /** Fraction of resolved packages whose size the registry publishes. */
    coverage: number;
    missingSizeCount: number;
    missingSizePackages: string[];
    conflictingPackages: Array<{ name: string; versions: string[] }>;
    heaviestPackages: Array<{ name: string; version: string; size: SizeField }>;
    depthReached: number;
    truncated: boolean;
    truncationReason: string | null;
    method: string;
    caveats: string[];
    source: string;
  } | null;

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

  const estimate = result.estimatedInstall;
  const estimateLine = estimate
    ? `Install footprint (estimated from registry metadata): ~${estimate.totalSize.human} on disk across ${
        estimate.packageCount
      } package${estimate.packageCount === 1 ? '' : 's'}` +
      (estimate.optionalSize.bytes ? `, of which ${estimate.optionalSize.human} is optional deps` : '') +
      (estimate.coverage < 1
        ? ` · lower bound: the registry publishes no size for ${estimate.missingSizeCount} of ${estimate.packageCount} packages (mostly pre-2018 publishes)`
        : '') +
      (estimate.truncated ? ' · ⚠️ walk truncated, so more is uncounted' : '')
    : null;

  // Pointless for a zero-dependency package, where the only entry is itself.
  const estimateHeaviest =
    estimate && estimate.packageCount > 1 && estimate.heaviestPackages.length > 0
      ? `Heaviest packages on disk: ${estimate.heaviestPackages
          .map((pkg) => `${pkg.name}@${pkg.version} (${pkg.size.human})`)
          .join(', ')}`
      : null;

  const conflicts =
    estimate && estimate.conflictingPackages.length > 0
      ? `⚠️ ${estimate.conflictingPackages.length} package(s) resolve at multiple versions and are counted once each: ${estimate.conflictingPackages
          .slice(0, 3)
          .map((entry) => `${entry.name} (${entry.versions.join(', ')})`)
          .join('; ')}`
      : null;

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
    estimateLine,
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
    conflicts,
    estimateHeaviest,
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

const ESTIMATE_CAVEATS: readonly string[] = Object.freeze([
  'Counts each distinct name@version once, approximating npm hoisting; a real install duplicates a package when dependents need incompatible versions.',
  'Includes optional dependencies, which npm skips when their os/cpu do not match the host. Subtract optionalSize for a platform-agnostic floor.',
  'Cannot see lockfile pins, overrides/resolutions, or bundledDependencies.',
  'Excludes devDependencies, matching a production install.',
]);

function shapeEstimate(estimate: InstallSizeEstimate | null): PackageSizeResult['estimatedInstall'] {
  if (!estimate) return null;

  const caveats = [...ESTIMATE_CAVEATS];
  if (estimate.coverage < 1) {
    caveats.push(
      `${estimate.missingSizeCount} of ${estimate.packageCount} packages publish no unpackedSize, so the total is a lower bound.`,
    );
  }
  if (estimate.truncated && estimate.truncationReason) caveats.push(estimate.truncationReason);

  return {
    totalSize: size(estimate.totalBytes),
    totalFiles: estimate.totalFiles,
    selfSize: size(estimate.selfBytes),
    optionalSize: size(estimate.optionalBytes),
    packageCount: estimate.packageCount,
    uniqueNames: estimate.uniqueNames,
    coverage: estimate.coverage,
    missingSizeCount: estimate.missingSizeCount,
    missingSizePackages: estimate.missingSizePackages,
    conflictingPackages: estimate.conflictingPackages,
    heaviestPackages: estimate.heaviestPackages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      size: size(pkg.bytes),
    })),
    depthReached: estimate.depthReached,
    truncated: estimate.truncated,
    truncationReason: estimate.truncationReason,
    method: 'Sum of dist.unpackedSize across the resolved production dependency graph.',
    caveats,
    source: 'https://registry.npmjs.org',
  };
}

export async function packageSize(args: PackageSizeInput): Promise<PackageSizeResult> {
  const packument = await getPackument(args.name);
  const resolved = resolveVersion(packument, args.version);
  const [manifest, bundleResult, estimateResult] = await Promise.all([
    getVersionManifest(packument.name, resolved.version),
    optional('bundlephobia', () => getBundleSize(packument.name, resolved.version)),
    optional('registry install estimate', () => estimateInstallSize(packument.name, resolved.version))
  ]);

  const notes = [bundleResult.note, estimateResult.note].filter((note): note is string => note !== null);

  return {
    name: packument.name,
    requestedVersion: resolved.requested,
    resolvedVersion: resolved.version,
    tarball: {
      unpackedSize: size(manifest.dist?.unpackedSize ?? null),
      fileCount: manifest.dist?.fileCount ?? null,
    },
    estimatedInstall: shapeEstimate(estimateResult.value),
    bundle: shapeBundle(bundleResult.value),
    notes
  };
}

export const packageSizeTool = defineTool({
  name: 'package_size',
  title: 'Measure package size',
  description:
    'Measure what a package actually costs. Returns the on-disk install footprint, derived from npm registry metadata ' +
    'by resolving the production dependency graph and summing unpacked sizes (reported as an estimate, with a coverage ' +
    'figure and caveats), plus browser bundle cost from bundlephobia (minified and min+gzip size, dependency count, ' +
    'whether it is tree-shakeable, and download-time estimates on slow 3G/4G). Use this for "how big is X", "will X ' +
    'bloat my bundle", or when comparing candidate libraries by weight.',
  inputSchema,
  input,
  handler: async (args) => {
    const result = await packageSize(args);
    
    return toolText(buildSummary(result), result, result.notes);
  }
});
