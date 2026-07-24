/**
 * Registry-derived install size estimation.
 *
 * Answers "what does `npm install X` cost on disk" without any third-party size
 * service. The npm registry publishes `dist.unpackedSize` for every version in
 * the *abbreviated* packument, so the figure can be reconstructed by resolving
 * the dependency graph and summing.
 *
 * This is an **estimate**, and the result says so. Specifically it:
 *   - sums each distinct `name@version` once, which approximates npm's hoisting;
 *     a real tree duplicates a package when two dependents need incompatible
 *     versions, so conflicts are reported for the caller to weigh
 *   - cannot see lockfile pins, `overrides`/`resolutions`, or `bundledDependencies`
 *   - counts optional dependencies, which npm skips when their `os`/`cpu` do not
 *     match the host — these are tracked separately so they can be subtracted
 *   - reports `coverage`, since a few old packages predate `unpackedSize`
 *
 * It shares the abbreviated-packument cache with `dependency_tree`, so calling
 * both in one session costs little more than calling one.
 */

import { getAbbreviatedPackument, type AbbreviatedPackument } from './npm.js';
import { classifyNonRegistrySpec, maxSatisfying } from './semver.js';
import { DEFAULT_CONCURRENCY, mapLimit } from './concurrency.js';

export const DEFAULT_ESTIMATE_DEPTH = 10;
export const DEFAULT_ESTIMATE_MAX_NODES = 500;

/** The only I/O this module performs, isolated so tests can supply a fake. */
export type PackumentFetcher = (name: string) => Promise<AbbreviatedPackument>;

export interface EstimateOptions {
  /** How deep to resolve. Defaults to 10, which covers nearly every real tree. */
  depth?: number;
  /** Ceiling on distinct packages resolved. Defaults to 500. */
  maxNodes?: number;
  /**
   * Include non-optional peer dependencies, which npm 7+ installs
   * automatically. Defaults to true, so the figure answers "what does adding
   * this to an empty project cost".
   */
  includePeer?: boolean;
  /**
   * Registry accessor, defaulting to the real cached client. Injected rather
   * than imported directly so the graph walk can be tested against a fixture
   * registry with no network access.
   */
  fetchPackument?: PackumentFetcher;
}

export interface SizedPackage {
  name: string;
  version: string;
  bytes: number | null;
  files: number | null;
  optional: boolean;
}

export interface InstallSizeEstimate {
  /** Sum of `unpackedSize` across the root and every resolved dependency. */
  totalBytes: number;
  totalFiles: number | null;
  /** Bytes attributable to optional dependencies, included in `totalBytes`. */
  optionalBytes: number;
  /** The root package on its own. */
  selfBytes: number | null;
  selfFiles: number | null;
  /** Distinct `name@version` pairs, including the root. */
  packageCount: number;
  /** Distinct package names — what a fully hoisted node_modules would hold. */
  uniqueNames: number;
  /** Packages the registry publishes no `unpackedSize` for. */
  missingSizeCount: number;
  missingSizePackages: string[];
  /** Fraction of resolved packages with a known size, 0-1. */
  coverage: number;
  /** Names resolved at more than one version; each copy is counted. */
  conflictingPackages: Array<{ name: string; versions: string[] }>;
  heaviestPackages: SizedPackage[];
  depthReached: number;
  truncated: boolean;
  truncationReason: string | null;
}

interface Edge {
  name: string;
  range: string;
  optional: boolean;
}

type AbbreviatedVersion = AbbreviatedPackument['versions'][string];

/** Prod + optional + (optionally) non-optional peer edges from one manifest. */
function edgesOf(entry: AbbreviatedVersion, includePeer: boolean): Edge[] {
  const edges: Edge[] = [];
  const optionalNames = new Set(Object.keys(entry.optionalDependencies ?? {}));
  const seen = new Set<string>();

  const push = (name: string, range: string, optional: boolean): void => {
    if (seen.has(name)) return;
    seen.add(name);
    edges.push({ name, range, optional });
  };

  for (const [name, range] of Object.entries(entry.dependencies ?? {})) {
    push(name, range, optionalNames.has(name));
  }
  for (const [name, range] of Object.entries(entry.optionalDependencies ?? {})) {
    push(name, range, true);
  }
  if (includePeer) {
    for (const [name, range] of Object.entries(entry.peerDependencies ?? {})) {
      // Optional peers are not auto-installed.
      if (entry.peerDependenciesMeta?.[name]?.optional === true) continue;
      push(name, range, false);
    }
  }

  return edges;
}

/** Resolves a range to a concrete published version, or null if it cannot. */
async function resolveEdgeVersion(edge: Edge, fetchPackument: PackumentFetcher): Promise<string | null> {
  const nonRegistry = classifyNonRegistrySpec(edge.range);

  const packument = await fetchPackument(edge.name).catch(() => null);
  if (!packument) return null;

  if (nonRegistry !== null) {
    // A dist-tag still resolves; git/file/workspace specs do not.
    return nonRegistry.kind === 'tag' ? (packument.distTags[edge.range] ?? null) : null;
  }

  return maxSatisfying(Object.keys(packument.versions), edge.range);
}

/**
 * Walks the dependency graph breadth-first, summing `dist.unpackedSize`.
 */
export async function estimateInstallSize(
  rootName: string,
  rootVersion: string,
  options: EstimateOptions = {},
): Promise<InstallSizeEstimate> {
  const depth = options.depth ?? DEFAULT_ESTIMATE_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_ESTIMATE_MAX_NODES;
  const includePeer = options.includePeer ?? true;
  const fetchPackument = options.fetchPackument ?? getAbbreviatedPackument;

  const resolved = new Map<string, SizedPackage>();
  const byName = new Map<string, Set<string>>();
  let truncated = false;
  let truncationReason: string | null = null;
  let depthReached = 0;

  const record = (name: string, version: string, entry: AbbreviatedVersion | undefined, optional: boolean): void => {
    const key = `${name}@${version}`;
    if (resolved.has(key)) return;
    resolved.set(key, {
      name,
      version,
      bytes: entry?.dist?.unpackedSize ?? null,
      files: entry?.dist?.fileCount ?? null,
      optional,
    });
    const versions = byName.get(name) ?? new Set<string>();
    versions.add(version);
    byName.set(name, versions);
  };

  const rootPackument = await fetchPackument(rootName);
  const rootEntry = rootPackument.versions[rootVersion];
  record(rootName, rootVersion, rootEntry, false);

  let frontier: Edge[] = rootEntry ? edgesOf(rootEntry, includePeer) : [];

  for (let level = 1; level <= depth && frontier.length > 0; level++) {
    if (resolved.size >= maxNodes) {
      truncated = true;
      truncationReason = `Stopped at ${maxNodes} packages; the estimate is a lower bound.`;
      break;
    }
    depthReached = level;

    const results = await mapLimit(frontier, DEFAULT_CONCURRENCY, async (edge) => {
      const version = await resolveEdgeVersion(edge, fetchPackument);
      if (version === null) return null;
      if (resolved.has(`${edge.name}@${version}`)) return null;

      const packument = await fetchPackument(edge.name).catch(() => null);
      return packument ? { edge, version, entry: packument.versions[version] } : null;
    });

    const next: Edge[] = [];
    for (const result of results) {
      if (!result) continue;
      if (resolved.size >= maxNodes) {
        truncated = true;
        truncationReason = `Stopped at ${maxNodes} packages; the estimate is a lower bound.`;
        break;
      }
      record(result.edge.name, result.version, result.entry, result.edge.optional);
      if (result.entry) {
        // Peers are only auto-installed for the root; transitively they are
        // expected to already be satisfied, so do not expand them again.
        for (const child of edgesOf(result.entry, false)) {
          // Inherit optionality: children of an optional package are only
          // installed if the parent is.
          next.push(result.edge.optional ? { ...child, optional: true } : child);
        }
      }
    }

    // Collapse duplicate (name, range) pairs so a diamond in the graph is
    // resolved once. Already-resolved versions are skipped inside the walk,
    // which is what actually guarantees termination on cycles.
    const deduped = new Map<string, Edge>();
    for (const edge of next) {
      const key = `${edge.name}@${edge.range}`;
      const existing = deduped.get(key);
      // A required path to a package wins over an optional one.
      if (!existing || (existing.optional && !edge.optional)) deduped.set(key, edge);
    }
    frontier = [...deduped.values()];

    if (level === depth && frontier.length > 0) {
      truncated = true;
      truncationReason ??= `Stopped at depth ${depth}; deeper dependencies are not counted.`;
    }
  }

  const packages = [...resolved.values()];
  const sized = packages.filter((pkg) => pkg.bytes !== null);
  const missing = packages.filter((pkg) => pkg.bytes === null);
  const root = resolved.get(`${rootName}@${rootVersion}`);

  return {
    totalBytes: sized.reduce((sum, pkg) => sum + (pkg.bytes ?? 0), 0),
    totalFiles: packages.every((pkg) => pkg.files === null)
      ? null
      : packages.reduce((sum, pkg) => sum + (pkg.files ?? 0), 0),
    optionalBytes: sized.filter((pkg) => pkg.optional).reduce((sum, pkg) => sum + (pkg.bytes ?? 0), 0),
    selfBytes: root?.bytes ?? null,
    selfFiles: root?.files ?? null,
    packageCount: packages.length,
    uniqueNames: byName.size,
    missingSizeCount: missing.length,
    missingSizePackages: missing.map((pkg) => `${pkg.name}@${pkg.version}`).slice(0, 10),
    coverage: packages.length === 0 ? 1 : Number((sized.length / packages.length).toFixed(3)),
    conflictingPackages: [...byName.entries()]
      .filter(([, versions]) => versions.size > 1)
      .map(([name, versions]) => ({ name, versions: [...versions].sort() }))
      .sort((a, b) => b.versions.length - a.versions.length || a.name.localeCompare(b.name)),
    heaviestPackages: [...sized].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, 5),
    depthReached,
    truncated,
    truncationReason,
  };
}
