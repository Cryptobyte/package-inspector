/**
 * Parsing of npm project manifests.
 *
 * The audit tool takes the manifest as *text* rather than a path: the MCP
 * client already has filesystem access and can paste the contents, which keeps
 * this server's "never touches the filesystem" property intact.
 *
 * Three shapes are understood:
 *   - `package.json`        — declared ranges for direct dependencies only
 *   - `package-lock.json` v2/v3 — the `packages` map, i.e. the entire installed
 *     tree at exact versions
 *   - `package-lock.json` v1 / `npm-shrinkwrap.json` — the legacy nested
 *     `dependencies` map, also exact
 *
 * Auditing a lockfile is both cheaper and more accurate than auditing a
 * package.json: versions are already resolved, so no registry round trip is
 * needed to pin them, and the transitive tree is included rather than inferred.
 *
 * Everything here is pure — no network, no filesystem.
 */

import { classifyNonRegistrySpec } from './semver.js';

export type DependencyKind = 'prod' | 'dev' | 'optional' | 'peer';

export type ManifestSource = 'package.json' | 'package-lock.json' | 'npm-shrinkwrap.json';

export interface DeclaredDependency {
  name: string;
  /** A declared range (package.json) or an exact version (lockfile). */
  spec: string;
  /** True when `spec` is already a concrete version needing no resolution. */
  exact: boolean;
  kind: DependencyKind;
  /** Present for lockfile entries: where in node_modules the copy lives. */
  path?: string;
}

export interface SkippedDependency {
  name: string;
  spec: string;
  reason: string;
}

export interface ParsedManifest {
  source: ManifestSource;
  lockfileVersion: number | null;
  projectName: string | null;
  projectVersion: string | null;
  /** True when the parsed set covers the whole installed tree, not just direct deps. */
  transitive: boolean;
  dependencies: DeclaredDependency[];
  skipped: SkippedDependency[];
}

export class ManifestParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestParseError';
  }
}

/** Non-registry specifiers cannot be looked up on npm, so they are reported, not dropped. */
function skipReason(spec: string): string | null {
  const classified = classifyNonRegistrySpec(spec);
  if (!classified) return null;
  switch (classified.kind) {
    case 'git':
      return 'git dependency — not published to the registry';
    case 'url':
      return 'tarball URL dependency';
    case 'file':
      return 'local file dependency';
    case 'workspace':
      return 'workspace protocol dependency';
    case 'link':
      return 'linked local dependency';
    case 'alias':
      return `npm alias of ${classified.aliasOf?.name} — audit that package directly`;
    case 'tag':
      // A dist-tag still resolves against the registry, so it is auditable.
      return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** `node_modules/a/node_modules/b` -> `b`; the last segment is the package. */
export function packageNameFromLockPath(path: string): string | null {
  const marker = 'node_modules/';
  const index = path.lastIndexOf(marker);
  if (index === -1) return null;
  const name = path.slice(index + marker.length);
  return name === '' ? null : name;
}

function parsePackageJson(doc: Record<string, unknown>, includeDev: boolean): ParsedManifest {
  const dependencies: DeclaredDependency[] = [];
  const skipped: SkippedDependency[] = [];
  const seen = new Set<string>();

  const groups: Array<{ field: string; kind: DependencyKind }> = [
    { field: 'dependencies', kind: 'prod' },
    { field: 'optionalDependencies', kind: 'optional' },
    { field: 'peerDependencies', kind: 'peer' },
    ...(includeDev ? [{ field: 'devDependencies', kind: 'dev' as DependencyKind }] : []),
  ];

  for (const { field, kind } of groups) {
    for (const [name, rawSpec] of Object.entries(asRecord(doc[field]))) {
      if (typeof rawSpec !== 'string') continue;
      // A package appearing in several groups is one installed copy.
      if (seen.has(name)) continue;
      seen.add(name);

      const reason = skipReason(rawSpec);
      if (reason) {
        skipped.push({ name, spec: rawSpec, reason });
        continue;
      }
      dependencies.push({ name, spec: rawSpec, exact: false, kind });
    }
  }

  return {
    source: 'package.json',
    lockfileVersion: null,
    projectName: typeof doc.name === 'string' ? doc.name : null,
    projectVersion: typeof doc.version === 'string' ? doc.version : null,
    transitive: false,
    dependencies,
    skipped,
  };
}

/** Lockfile v2/v3: a flat `packages` map keyed by install path. */
function parseLockPackages(
  doc: Record<string, unknown>,
  source: ManifestSource,
  includeDev: boolean,
): ParsedManifest {
  const packages = asRecord(doc.packages);
  const dependencies: DeclaredDependency[] = [];
  const skipped: SkippedDependency[] = [];
  const seen = new Set<string>();

  const root = asRecord(packages['']);

  for (const [path, rawEntry] of Object.entries(packages)) {
    if (path === '') continue; // the project itself
    const entry = asRecord(rawEntry);

    // Workspace links point at local directories, not registry packages.
    if (entry.link === true) continue;

    const name = typeof entry.name === 'string' ? entry.name : packageNameFromLockPath(path);
    if (!name) continue;

    const version = typeof entry.version === 'string' ? entry.version : null;
    const isDev = entry.dev === true || entry.devOptional === true;
    if (isDev && !includeDev) continue;

    if (typeof entry.resolved === 'string' && !entry.resolved.includes('registry.npmjs.org')) {
      const reason = skipReason(entry.resolved) ?? 'not resolved from the npm registry';
      skipped.push({ name, spec: entry.resolved, reason });
      continue;
    }

    if (!version) {
      skipped.push({ name, spec: path, reason: 'lockfile entry has no version' });
      continue;
    }

    // The same name can legitimately appear at several versions (nested copies);
    // each is separately installed, so each is separately auditable.
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);

    dependencies.push({
      name,
      spec: version,
      exact: true,
      kind: entry.optional === true ? 'optional' : isDev ? 'dev' : 'prod',
      path,
    });
  }

  return {
    source,
    lockfileVersion: typeof doc.lockfileVersion === 'number' ? doc.lockfileVersion : null,
    projectName: (typeof doc.name === 'string' ? doc.name : null) ?? (typeof root.name === 'string' ? root.name : null),
    projectVersion:
      (typeof doc.version === 'string' ? doc.version : null) ?? (typeof root.version === 'string' ? root.version : null),
    transitive: true,
    dependencies,
    skipped,
  };
}

/** Lockfile v1: a nested `dependencies` map. */
function parseLockV1(doc: Record<string, unknown>, source: ManifestSource, includeDev: boolean): ParsedManifest {
  const dependencies: DeclaredDependency[] = [];
  const skipped: SkippedDependency[] = [];
  const seen = new Set<string>();

  const visit = (node: Record<string, unknown>): void => {
    for (const [name, rawEntry] of Object.entries(asRecord(node.dependencies))) {
      const entry = asRecord(rawEntry);
      const version = typeof entry.version === 'string' ? entry.version : null;
      const isDev = entry.dev === true;

      if (!(isDev && !includeDev)) {
        if (version && !/^[\d]/.test(version)) {
          // v1 stores git/url deps in `version`, not a semver string.
          skipped.push({ name, spec: version, reason: skipReason(version) ?? 'not a registry version' });
        } else if (version) {
          const key = `${name}@${version}`;
          if (!seen.has(key)) {
            seen.add(key);
            dependencies.push({
              name,
              spec: version,
              exact: true,
              kind: entry.optional === true ? 'optional' : isDev ? 'dev' : 'prod',
            });
          }
        }
      }

      if (entry.dependencies) visit(entry);
    }
  };

  visit(doc);

  return {
    source,
    lockfileVersion: typeof doc.lockfileVersion === 'number' ? doc.lockfileVersion : 1,
    projectName: typeof doc.name === 'string' ? doc.name : null,
    projectVersion: typeof doc.version === 'string' ? doc.version : null,
    transitive: true,
    dependencies,
    skipped,
  };
}

/**
 * Parses manifest text, detecting which of the supported shapes it is.
 */
export function parseManifest(text: string, options: { includeDev?: boolean } = {}): ParsedManifest {
  const includeDev = options.includeDev === true;

  if (typeof text !== 'string' || text.trim() === '') {
    throw new ManifestParseError('The manifest is empty. Paste the contents of a package.json or package-lock.json.');
  }

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new ManifestParseError(
      `The manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}. ` +
        'Paste the raw file contents, not a summary of them.',
    );
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ManifestParseError('The manifest must be a JSON object.');
  }

  const record = doc as Record<string, unknown>;
  const isLock = record.lockfileVersion !== undefined || record.packages !== undefined;

  if (isLock) {
    // A shrinkwrap is byte-identical to a lockfile apart from its filename; the
    // only hint is the caller's own naming, so report the generic form.
    const source: ManifestSource = 'package-lock.json';
    const version = typeof record.lockfileVersion === 'number' ? record.lockfileVersion : 1;
    const parsed = version >= 2 || record.packages !== undefined
      ? parseLockPackages(record, source, includeDev)
      : parseLockV1(record, source, includeDev);

    if (parsed.dependencies.length === 0 && parsed.skipped.length === 0) {
      throw new ManifestParseError('The lockfile declares no dependencies.');
    }
    return parsed;
  }

  if (
    record.dependencies === undefined &&
    record.devDependencies === undefined &&
    record.optionalDependencies === undefined &&
    record.peerDependencies === undefined
  ) {
    throw new ManifestParseError(
      'No dependencies found. Expected a package.json with a dependencies field, or a package-lock.json.',
    );
  }

  return parsePackageJson(record, includeDev);
}
