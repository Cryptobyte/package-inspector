/**
 * npm registry and download-counts clients.
 *
 * Talks to exactly two hosts:
 *   - registry.npmjs.org  (packuments, single-version manifests, search, attestations)
 *   - api.npmjs.org       (download counts)
 *
 * Full packuments can be tens of megabytes for packages with thousands of
 * releases, so every fetch is projected down to the fields we actually use
 * before it enters the cache. Tree walking uses the registry's *abbreviated*
 * packument (`application/vnd.npm.install-v1+json`), which is an order of
 * magnitude smaller.
 */

import { cached, DEFAULT_TTL_MS, fetchJson } from './http.js';
import { ToolError } from './errors.js';
import { maxVersion, sortDescending } from './semver.js';

const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS = 'https://api.npmjs.org';
const ABBREVIATED_ACCEPT = 'application/vnd.npm.install-v1+json';

/** npm's own validation rules, minus the ones the registry no longer enforces. */
const PACKAGE_NAME_RE = /^(?:@[^/\s@]+\/)?[^/\s@][^/\s@]*$/;
const ILLEGAL_NAME_RE = /[~)('!*\\]|^\.|^_/;

/**
 * Validates a package name before it is ever interpolated into a URL.
 * This is the guard that makes path traversal via package names impossible.
 */
export function assertValidPackageName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new ToolError('INVALID_INPUT', 'Package name must not be empty.');
  if (trimmed.length > 214) {
    throw new ToolError('INVALID_INPUT', 'Package name must be 214 characters or fewer.');
  }
  if (!PACKAGE_NAME_RE.test(trimmed) || ILLEGAL_NAME_RE.test(trimmed)) {
    throw new ToolError(
      'INVALID_INPUT',
      `"${name}" is not a valid npm package name.`,
      'Names look like "lodash" or "@scope/name".',
    );
  }
  if (trimmed.includes('..')) {
    throw new ToolError('INVALID_INPUT', `"${name}" is not a valid npm package name.`);
  }
  return trimmed;
}

/** A version or dist-tag, e.g. `1.2.3`, `latest`, `next`. */
const VERSION_SPEC_RE = /^[\w.\-+]+$/;

export function assertValidVersionSpec(version: string): string {
  const trimmed = version.trim();
  if (trimmed.length === 0) throw new ToolError('INVALID_INPUT', 'Version must not be empty.');
  if (trimmed.length > 128 || !VERSION_SPEC_RE.test(trimmed)) {
    throw new ToolError(
      'INVALID_INPUT',
      `"${version}" is not a valid version or dist-tag.`,
      'Use an exact version like "1.2.3" or a tag like "latest".',
    );
  }
  return trimmed;
}

/** Registry path form: `@scope/name` -> `@scope%2fname`. */
function registryPath(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

/** The downloads API expects scoped names with a literal slash. */
function downloadsPath(name: string): string {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1)).replace(/%2F/gi, '/')}` : encodeURIComponent(name);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Maintainer {
  name: string;
  email?: string;
}

export interface Dist {
  tarball?: string;
  shasum?: string;
  integrity?: string;
  fileCount?: number;
  unpackedSize?: number;
  signatures?: Array<{ keyid?: string; sig?: string }>;
  attestations?: { url?: string; provenance?: { predicateType?: string } };
}

/** A single version entry as it appears in a packument. */
export interface VersionManifest {
  name: string;
  version: string;
  description?: string;
  license?: unknown;
  main?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  bin?: unknown;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  optionalDependencies?: Record<string, string>;
  bundleDependencies?: string[] | boolean;
  engines?: Record<string, string>;
  os?: string[];
  cpu?: string[];
  deprecated?: string;
  repository?: unknown;
  homepage?: string;
  author?: unknown;
  maintainers?: Maintainer[];
  keywords?: string[];
  dist?: Dist;
  hasInstallScript?: boolean;
  sideEffects?: unknown;
  _npmUser?: { name?: string; email?: string };
  _hasShrinkwrap?: boolean;
}

/** The projection of a full packument that we keep in memory. */
export interface Packument {
  name: string;
  description: string | null;
  distTags: Record<string, string>;
  versions: string[];
  /** Publish time per version, plus the `created` / `modified` entries. */
  time: Record<string, string>;
  /** Version -> deprecation message, only for deprecated versions. */
  deprecatedVersions: Record<string, string>;
  license: unknown;
  homepage: string | null;
  repository: unknown;
  bugs: unknown;
  keywords: string[];
  author: unknown;
  maintainers: Maintainer[];
  readmeFilename: string | null;
}

export interface AbbreviatedPackument {
  name: string;
  distTags: Record<string, string>;
  versions: Record<
    string,
    {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      optionalDependencies?: Record<string, string>;
      engines?: Record<string, string>;
      deprecated?: string;
      hasInstallScript?: boolean;
      dist?: Dist;
    }
  >;
}

interface RawPackument {
  name?: string;
  description?: string;
  'dist-tags'?: Record<string, string>;
  versions?: Record<string, VersionManifest>;
  time?: Record<string, string>;
  license?: unknown;
  homepage?: string;
  repository?: unknown;
  bugs?: unknown;
  keywords?: string[];
  author?: unknown;
  maintainers?: Maintainer[];
  readmeFilename?: string;
}

// ---------------------------------------------------------------------------
// Registry reads
// ---------------------------------------------------------------------------

function notFound(name: string): ToolError {
  return new ToolError(
    'NOT_FOUND',
    `Package "${name}" was not found on the npm registry.`,
    'Check the spelling, or use search_packages to find the right name.',
  );
}

/**
 * Fetches and projects the full packument (needed for publish times,
 * maintainers and per-version deprecation messages).
 */
export async function getPackument(name: string): Promise<Packument> {
  const pkg = assertValidPackageName(name);

  return cached(`packument:${pkg}`, DEFAULT_TTL_MS, async () => {
    const raw = await fetchJson<RawPackument>(`${REGISTRY}/${registryPath(pkg)}`, {
      source: 'npm registry',
      notFoundAsNull: true,
    });
    if (!raw || !raw.versions) throw notFound(pkg);

    const deprecatedVersions: Record<string, string> = {};
    for (const [version, manifest] of Object.entries(raw.versions)) {
      if (typeof manifest?.deprecated === 'string' && manifest.deprecated.length > 0) {
        deprecatedVersions[version] = manifest.deprecated;
      }
    }

    return {
      name: raw.name ?? pkg,
      description: raw.description ?? null,
      distTags: raw['dist-tags'] ?? {},
      versions: Object.keys(raw.versions),
      time: raw.time ?? {},
      deprecatedVersions,
      license: raw.license ?? null,
      homepage: raw.homepage ?? null,
      repository: raw.repository ?? null,
      bugs: raw.bugs ?? null,
      keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
      author: raw.author ?? null,
      maintainers: Array.isArray(raw.maintainers) ? raw.maintainers : [],
      readmeFilename: raw.readmeFilename ?? null,
    } satisfies Packument;
  });
}

/** Fetches the abbreviated packument — small, and enough to walk a tree. */
export async function getAbbreviatedPackument(name: string): Promise<AbbreviatedPackument> {
  const pkg = assertValidPackageName(name);

  return cached(`abbrev:${pkg}`, DEFAULT_TTL_MS, async () => {
    const raw = await fetchJson<{
      name?: string;
      'dist-tags'?: Record<string, string>;
      versions?: AbbreviatedPackument['versions'];
    }>(`${REGISTRY}/${registryPath(pkg)}`, {
      source: 'npm registry',
      notFoundAsNull: true,
      headers: { accept: ABBREVIATED_ACCEPT },
    });
    if (!raw || !raw.versions) throw notFound(pkg);

    return {
      name: raw.name ?? pkg,
      distTags: raw['dist-tags'] ?? {},
      versions: raw.versions,
    } satisfies AbbreviatedPackument;
  });
}

/**
 * Fetches a single version manifest (`/pkg/1.2.3`), which the registry serves
 * with `scripts` and `_npmUser` intact — both needed for supply-chain analysis.
 */
export async function getVersionManifest(
  name: string,
  version: string,
  options: { timeoutMs?: number } = {},
): Promise<VersionManifest> {
  const pkg = assertValidPackageName(name);
  const spec = assertValidVersionSpec(version);

  return cached(`manifest:${pkg}@${spec}`, DEFAULT_TTL_MS, async () => {
    const raw = await fetchJson<VersionManifest>(`${REGISTRY}/${registryPath(pkg)}/${encodeURIComponent(spec)}`, {
      source: 'npm registry',
      notFoundAsNull: true,
      // Callers fanning out over a whole tree pass a shorter budget so one
      // straggler cannot monopolise a concurrency slot.
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (!raw || !raw.version) {
      // Distinguish "no such package" from "no such version" for a better message.
      const packument = await getPackument(pkg).catch(() => null);
      if (!packument) throw notFound(pkg);
      const known = sortDescending(packument.versions).slice(0, 5).join(', ');
      throw new ToolError(
        'NOT_FOUND',
        `Version "${spec}" of "${pkg}" does not exist.`,
        `Latest versions are: ${known}. Available dist-tags: ${Object.keys(packument.distTags).join(', ') || 'none'}.`,
      );
    }
    return raw;
  });
}

export interface ResolvedVersion {
  /** What the caller asked for (`latest`, `^1.0.0`, `1.2.3`…). */
  requested: string;
  /** The concrete version it resolved to. */
  version: string;
  /** True when `requested` was a dist-tag rather than an exact version. */
  fromDistTag: boolean;
}

/**
 * Resolves a version spec against a packument. Accepts exact versions and
 * dist-tags; `latest` is the default everywhere in this server.
 */
export function resolveVersion(packument: Packument, requested = 'latest'): ResolvedVersion {
  const spec = requested.trim() || 'latest';

  const tagged = packument.distTags[spec];
  if (tagged) return { requested: spec, version: tagged, fromDistTag: true };

  if (packument.versions.includes(spec)) {
    return { requested: spec, version: spec, fromDistTag: false };
  }

  // A bare `latest` on a package with no dist-tags: fall back to the highest.
  if (spec === 'latest') {
    const highest = maxVersion(packument.versions);
    if (highest) return { requested: spec, version: highest, fromDistTag: false };
  }

  const known = sortDescending(packument.versions).slice(0, 5).join(', ');
  const tags = Object.keys(packument.distTags).join(', ');
  throw new ToolError(
    'NOT_FOUND',
    `Version "${spec}" of "${packument.name}" does not exist.`,
    `Recent versions: ${known || 'none'}.${tags ? ` Dist-tags: ${tags}.` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Download counts
// ---------------------------------------------------------------------------

export type DownloadPeriod = 'last-day' | 'last-week' | 'last-month' | 'last-year';

export interface DownloadPoint {
  downloads: number;
  start: string;
  end: string;
  package: string;
}

/** Point download count. `period` may also be an explicit `YYYY-MM-DD:YYYY-MM-DD` range. */
export async function getDownloadPoint(name: string, period: string): Promise<DownloadPoint | null> {
  const pkg = assertValidPackageName(name);
  if (!/^[\w-]+$|^\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/.test(period)) {
    throw new ToolError('INVALID_INPUT', `"${period}" is not a valid download period.`);
  }

  return cached(`downloads:${period}:${pkg}`, DEFAULT_TTL_MS, async () => {
    const raw = await fetchJson<DownloadPoint & { error?: string }>(
      `${DOWNLOADS}/downloads/point/${period}/${downloadsPath(pkg)}`,
      { source: 'npm downloads API', notFoundAsNull: true },
    );
    if (!raw || raw.error || typeof raw.downloads !== 'number') return null;
    return raw;
  });
}

export interface DownloadRange {
  start: string;
  end: string;
  package: string;
  downloads: Array<{ day: string; downloads: number }>;
}

export async function getDownloadRange(name: string, start: string, end: string): Promise<DownloadRange | null> {
  const pkg = assertValidPackageName(name);
  const range = `${start}:${end}`;
  if (!/^\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$/.test(range)) {
    throw new ToolError('INVALID_INPUT', `"${range}" is not a valid YYYY-MM-DD:YYYY-MM-DD range.`);
  }

  return cached(`range:${range}:${pkg}`, DEFAULT_TTL_MS, async () => {
    const raw = await fetchJson<DownloadRange & { error?: string }>(
      `${DOWNLOADS}/downloads/range/${range}/${downloadsPath(pkg)}`,
      { source: 'npm downloads API', notFoundAsNull: true },
    );
    if (!raw || raw.error || !Array.isArray(raw.downloads)) return null;
    return raw;
  });
}

/**
 * Bulk download counts. The npm bulk endpoint accepts up to 128 unscoped
 * packages per call and rejects scoped ones, so scoped names fall back to
 * individual point lookups.
 */
export async function getBulkDownloads(
  names: readonly string[],
  period: DownloadPeriod = 'last-week',
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (names.length === 0) return result;

  const unscoped = names.filter((name) => !name.startsWith('@')).slice(0, 128);
  const scoped = names.filter((name) => name.startsWith('@'));

  if (unscoped.length > 0) {
    const joined = unscoped.map((name) => encodeURIComponent(name)).join(',');
    const raw = await fetchJson<Record<string, { downloads?: number } | null>>(
      `${DOWNLOADS}/downloads/point/${period}/${joined}`,
      { source: 'npm downloads API', notFoundAsNull: true },
    ).catch(() => null);

    if (raw && typeof raw === 'object') {
      // A single-package bulk query returns the point object directly.
      if ('downloads' in raw && typeof (raw as { downloads?: unknown }).downloads === 'number') {
        const only = unscoped[0];
        if (only) result.set(only, (raw as unknown as DownloadPoint).downloads);
      } else {
        for (const [key, value] of Object.entries(raw)) {
          if (value && typeof value.downloads === 'number') result.set(key, value.downloads);
        }
      }
    }
  }

  for (const name of scoped.slice(0, 20)) {
    const point = await getDownloadPoint(name, period).catch(() => null);
    if (point) result.set(name, point.downloads);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchResultObject {
  package: {
    name: string;
    version: string;
    description?: string;
    keywords?: string[];
    date?: string;
    publisher?: { username?: string };
    maintainers?: Maintainer[];
    links?: { npm?: string; homepage?: string; repository?: string; bugs?: string };
  };
  score: { final: number; detail: { quality: number; popularity: number; maintenance: number } };
  searchScore: number;
}

export async function searchRegistry(query: string, size: number): Promise<{ total: number; objects: SearchResultObject[] }> {
  const url = new URL(`${REGISTRY}/-/v1/search`);
  url.searchParams.set('text', query);
  url.searchParams.set('size', String(size));

  const raw = await cached(`search:${size}:${query}`, DEFAULT_TTL_MS, () =>
    fetchJson<{ total?: number; objects?: SearchResultObject[] }>(url.toString(), { source: 'npm registry search' }),
  );

  return { total: raw?.total ?? 0, objects: Array.isArray(raw?.objects) ? raw.objects : [] };
}

// ---------------------------------------------------------------------------
// Provenance / attestations
// ---------------------------------------------------------------------------

export interface AttestationInfo {
  present: boolean;
  predicateTypes: string[];
  /** True when a SLSA provenance attestation is present. */
  hasProvenance: boolean;
  /** True when the publish attestation (npm's own signature) is present. */
  hasPublishAttestation: boolean;
}

/**
 * Best-effort provenance lookup. Most packages have no attestations at all and
 * the endpoint simply 404s, which is reported as `present: false` rather than
 * as an error.
 */
export async function getAttestations(name: string, version: string): Promise<AttestationInfo> {
  const pkg = assertValidPackageName(name);
  const spec = assertValidVersionSpec(version);

  return cached(`attest:${pkg}@${spec}`, DEFAULT_TTL_MS, async () => {
    const raw = await fetchJson<{
      attestations?: Array<{ predicateType?: string; bundle?: unknown }>;
    }>(`${REGISTRY}/-/npm/v1/attestations/${registryPath(pkg)}@${encodeURIComponent(spec)}`, {
      source: 'npm attestations API',
      notFoundAsNull: true,
    });

    const attestations = Array.isArray(raw?.attestations) ? raw.attestations : [];
    const predicateTypes = attestations
      .map((entry) => entry?.predicateType)
      .filter((value): value is string => typeof value === 'string');

    return {
      present: attestations.length > 0,
      predicateTypes,
      hasProvenance: predicateTypes.some((type) => type.includes('provenance') || type.includes('slsa')),
      hasPublishAttestation: predicateTypes.some((type) => type.includes('publish')),
    } satisfies AttestationInfo;
  });
}

// ---------------------------------------------------------------------------
// Shared derivations
// ---------------------------------------------------------------------------

/** npm's `license` field may be a string, an object, or a legacy array. */
export function normalizeLicense(license: unknown): string | null {
  if (typeof license === 'string') return license.trim() || null;
  if (Array.isArray(license)) {
    const parts = license.map(normalizeLicense).filter((value): value is string => value !== null);
    return parts.length > 0 ? parts.join(' OR ') : null;
  }
  if (license && typeof license === 'object' && 'type' in license) {
    const type = (license as { type?: unknown }).type;
    return typeof type === 'string' ? type : null;
  }
  return null;
}

/** npm's `author` field may be a string or a person object. */
export function normalizePerson(person: unknown): string | null {
  if (typeof person === 'string') return person.trim() || null;
  if (person && typeof person === 'object' && 'name' in person) {
    const name = (person as { name?: unknown }).name;
    return typeof name === 'string' ? name : null;
  }
  return null;
}

/** Whether a manifest ships its own TypeScript declarations. */
export function shipsOwnTypes(manifest: VersionManifest): boolean {
  if (typeof manifest.types === 'string' || typeof manifest.typings === 'string') return true;
  // `exports` maps can declare types per condition.
  return JSON.stringify(manifest.exports ?? null).includes('"types"');
}

/** `@types/foo`; scoped `@scope/foo` becomes `@types/scope__foo`. */
export function typesPackageName(name: string): string {
  if (!name.startsWith('@')) return `@types/${name}`;
  const [scope, rest] = name.slice(1).split('/');
  return `@types/${scope}__${rest}`;
}
