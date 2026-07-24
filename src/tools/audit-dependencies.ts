/**
 * `audit_dependencies` — audits an entire project at once.
 *
 * Every other tool in this server answers a question about one package. This
 * one answers the question people actually have: "what is wrong with my
 * project?" It takes the manifest as text, screens the whole dependency set for
 * advisories in a single OSV request, and reports what to fix first.
 *
 * Cost shape, which is why this is practical at all:
 *   - 1 OSV batch request screens every dependency (ids only, no detail)
 *   - full advisory detail is fetched only for the few packages that are hit
 *   - 1 small registry request per unique package for deprecation, install
 *     scripts and licence — 2 for package.json input, which must also resolve
 *     ranges to concrete versions first
 *
 * Auditing a lockfile is both cheaper and more complete than auditing a
 * package.json: versions are already pinned, and the whole transitive tree is
 * present rather than just direct dependencies.
 */

import { z } from 'zod';
import {
  getAbbreviatedPackument,
  getVersionManifest,
  normalizeLicense,
  type VersionManifest,
} from '../lib/npm.js';
import { queryOsv, screenOsvBatch, type Advisory } from '../lib/osv.js';
import { ManifestParseError, parseManifest, type DependencyKind, type ParsedManifest } from '../lib/manifest.js';
import { maxSatisfying } from '../lib/semver.js';
import { highestRating, ratingRank, type CvssRating } from '../lib/cvss.js';
import { DEFAULT_CONCURRENCY, mapLimit } from '../lib/concurrency.js';
import { ToolError, optional } from '../lib/errors.js';
import { lines, truncate } from '../lib/format.js';
import { toolText } from '../lib/response.js';
import { defineTool, type JsonSchemaObject } from './types.js';

const DEFAULT_MAX_DEPENDENCIES = 250;

const input = z.object({
  manifest: z.string().min(2).max(4_000_000),
  includeDev: z.boolean().optional().default(false),
  maxDependencies: z.number().int().min(1).max(1000).optional().default(DEFAULT_MAX_DEPENDENCIES)
});

export type AuditDependenciesInput = z.infer<typeof input>;

const inputSchema: JsonSchemaObject = {
  type: 'object',
  properties: {
    manifest: {
      type: 'string',
      minLength: 2,
      maxLength: 4000000,
      description:
        'The raw contents of a package.json, package-lock.json, or npm-shrinkwrap.json. Paste the file text itself — ' +
        'this server never reads the filesystem. A lockfile gives a better audit than a package.json because it pins ' +
        'exact versions and includes the whole transitive tree.'
    },
    includeDev: {
      type: 'boolean',
      default: false,
      description: 'Audit devDependencies too. Defaults to false, matching what ships to production.'
    },
    maxDependencies: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      default: DEFAULT_MAX_DEPENDENCIES,
      description: 'Safety cap on how many dependencies to audit. Defaults to 250; the result flags when it is hit.'
    }
  },
  required: ['manifest'],
  additionalProperties: false
};

export type IssueKind = 'vulnerability' | 'deprecated' | 'install-script' | 'license' | 'unresolved';

export interface AuditIssue {
  kind: IssueKind;
  severity: CvssRating | 'info';
  detail: string;
}

export interface AuditedDependency {
  name: string;
  /** The declared range, or the pinned version for lockfile input. */
  spec: string;
  version: string | null;
  kind: DependencyKind;
  clean: boolean;
  issues: AuditIssue[];
  vulnerabilities: Advisory[];
  highestSeverity: CvssRating | null;
  /** Lowest published version clearing every advisory found, if one exists. */
  recommendedUpgrade: string | null;
  deprecated: string | null;
  installScripts: string[];
  license: string | null;
  /** False when registry metadata could not be read; findings below are partial. */
  metadataChecked: boolean;
}

export interface AuditAction {
  priority: number;
  package: string;
  action: string;
  reason: string;
}

export interface AuditDependenciesResult {
  project: { name: string | null; version: string | null };
  source: ParsedManifest['source'];
  lockfileVersion: number | null;
  /** True when the audit covered the whole installed tree, not just direct deps. */
  transitive: boolean;
  /** Whether devDependencies were in scope. */
  includeDev: boolean;
  verdict: string;
  audited: number;
  totalDeclared: number;
  truncated: boolean;
  counts: {
    clean: number;
    vulnerable: number;
    deprecated: number;
    withInstallScripts: number;
    licenseIssues: number;
    /** Dependencies whose registry metadata could not be read this run. */
    unchecked: number;
  };
  severityCounts: Record<'critical' | 'high' | 'medium' | 'low' | 'unknown', number>;
  highestSeverity: CvssRating | null;
  /** What to fix first, most urgent last-resort-free ordering. */
  actions: AuditAction[];
  dependencies: AuditedDependency[];
  skipped: ParsedManifest['skipped'];
  notes: string[];
}

/** Licenses we treat as fine without comment; anything else is worth a look. */
const UNPROBLEMATIC_LICENSE = /^(MIT|ISC|BSD-[23]-CLAUSE|APACHE-2\.0|0BSD|CC0-1\.0|UNLICENSE|BLUEOAK-1\.0\.0|WTFPL|MIT-0|PYTHON-2\.0|ZLIB)$/;
const COPYLEFT_LICENSE = /^(A?GPL|LGPL)/;

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'] as const;

function licenseIssue(license: string | null): AuditIssue | null {
  if (!license) {
    return { kind: 'license', severity: 'medium', detail: 'No license declared — you have no legal right to use it.' };
  }
  const normalized = license.trim().toUpperCase();
  if (normalized === 'UNLICENSED' || normalized.startsWith('SEE LICENSE')) {
    return { kind: 'license', severity: 'medium', detail: `Non-standard license "${license}" — read the terms.` };
  }
  if (COPYLEFT_LICENSE.test(normalized)) {
    return { kind: 'license', severity: 'low', detail: `Copyleft license "${license}" — check commercial compatibility.` };
  }
  if (!UNPROBLEMATIC_LICENSE.test(normalized) && !normalized.includes(' OR ') && !normalized.includes(' AND ')) {
    return { kind: 'license', severity: 'info', detail: `Unrecognised license identifier "${license}".` };
  }
  return null;
}

/**
 * Orders findings into a fix list. Pure, so the prioritisation is testable
 * without touching the network.
 */
export function buildActions(dependencies: readonly AuditedDependency[]): AuditAction[] {
  const weight = (dependency: AuditedDependency): number => {
    if (dependency.highestSeverity) return 100 - ratingRank(dependency.highestSeverity) * 10;
    if (dependency.deprecated) return 70;
    if (dependency.installScripts.length > 0) return 80;
    if (dependency.issues.some((issue) => issue.kind === 'license' && issue.severity === 'medium')) return 85;
    return 999;
  };

  // Keyed off the signals themselves rather than the issues array, so the fix
  // list cannot drift from what was actually found. A dependency we could not
  // read has no signals — that is a coverage gap, reported separately rather
  // than crowding out real work.
  const actionable = (dependency: AuditedDependency): boolean =>
    dependency.vulnerabilities.length > 0 ||
    dependency.deprecated !== null ||
    dependency.installScripts.length > 0 ||
    dependency.issues.some((issue) => issue.kind === 'license');

  return dependencies
    .filter((dependency) => !dependency.clean)
    .filter(actionable)
    .map((dependency) => ({ dependency, weight: weight(dependency) }))
    .sort((a, b) => a.weight - b.weight || a.dependency.name.localeCompare(b.dependency.name))
    .slice(0, 25)
    .map(({ dependency }, index) => {
      const at = `${dependency.name}@${dependency.version ?? dependency.spec}`;

      if (dependency.vulnerabilities.length > 0) {
        const count = dependency.vulnerabilities.length;
        return {
          priority: index + 1,
          package: at,
          action: dependency.recommendedUpgrade
            ? `Upgrade to ${dependency.recommendedUpgrade}`
            : 'Review each advisory; no single published version clears them all',
          reason: `${count} known ${count === 1 ? 'vulnerability' : 'vulnerabilities'}, highest ${dependency.highestSeverity ?? 'unknown'}`,
        };
      }
      if (dependency.deprecated) {
        return {
          priority: index + 1,
          package: at,
          action: 'Replace it',
          reason: `Deprecated: ${truncate(dependency.deprecated, 120)}`,
        };
      }
      if (dependency.installScripts.length > 0) {
        return {
          priority: index + 1,
          package: at,
          action: 'Review the install script, or install with --ignore-scripts',
          reason: `Runs ${dependency.installScripts.join(', ')} on install`,
        };
      }
      const issue = dependency.issues[0];
      return {
        priority: index + 1,
        package: at,
        action: 'Review',
        reason: issue?.detail ?? 'See findings',
      };
    });
}

function buildSummary(result: AuditDependenciesResult): string {
  const { counts } = result;
  const scope = result.transitive ? 'the full dependency tree' : 'direct dependencies';

  const headline =
    counts.vulnerable === 0 && counts.deprecated === 0 && counts.withInstallScripts === 0
      ? `✅ ${result.project.name ?? 'project'} — no vulnerabilities, deprecations, or install scripts across ${result.audited} ${scope}.`
      : `${result.highestSeverity === 'critical' || result.highestSeverity === 'high' ? '🔴' : '🟠'} ${
          result.project.name ?? 'project'
        } — ${result.verdict}`;

  const actionLines = result.actions
    .slice(0, 10)
    .map((action) => `${action.priority}. ${action.package} — ${action.action}\n   ${action.reason}`)
    .join('\n');

  return lines(
    headline,
    `Audited ${result.audited} of ${result.totalDeclared} declared (${scope}, from ${result.source}${
      result.lockfileVersion ? ` v${result.lockfileVersion}` : ''
    })${result.includeDev ? ', including devDependencies' : ''}`,
    '',
    counts.vulnerable > 0
      ? `Vulnerable: ${counts.vulnerable} · critical ${result.severityCounts.critical}, high ${result.severityCounts.high}, medium ${result.severityCounts.medium}, low ${result.severityCounts.low}`
      : 'Vulnerable: none',
    `Deprecated: ${counts.deprecated} · Install scripts: ${counts.withInstallScripts} · License concerns: ${counts.licenseIssues}`,
    counts.unchecked > 0
      ? `⚠️ ${counts.unchecked} dependency/dependencies could not be checked for deprecation, install scripts or license — unknown, not clean.`
      : null,
    actionLines ? `\nFix in this order:\n${actionLines}` : null,
    result.actions.length > 10 ? `… and ${result.actions.length - 10} more (see JSON).` : null,
    result.truncated
      ? `\n⚠️ Only the first ${result.audited} dependencies were audited. Raise maxDependencies for full coverage.`
      : null,
    result.skipped.length > 0
      ? `\n${result.skipped.length} dependency/dependencies could not be audited (git, file, or workspace specifiers): ${result.skipped
          .slice(0, 5)
          .map((entry) => entry.name)
          .join(', ')}`
      : null,
    !result.transitive
      ? '\nNote: this audited declared direct dependencies only. Pass a package-lock.json to audit the whole installed tree.'
      : null,
  );
}

/** Per-package registry reads get a tighter budget than a single-package tool. */
const FANOUT_TIMEOUT_MS = 6_000;

interface Inspected {
  version: string | null;
  manifest: VersionManifest | null;
  hasInstallScript: boolean;
  /**
   * Whether the registry facts were actually retrieved. Critical: a failed
   * lookup must never be reported as "no license" or "not deprecated" — the
   * absence of an answer is not a negative answer.
   */
  checked: boolean;
}

async function inspectOne(name: string, spec: string, exact: boolean): Promise<Inspected> {
  let version: string | null = exact ? spec : null;
  let hasInstallScript = false;

  if (!exact) {
    const abbreviated = await getAbbreviatedPackument(name).catch(() => null);
    if (!abbreviated) return { version: null, manifest: null, hasInstallScript: false, checked: false };
    version = maxSatisfying(Object.keys(abbreviated.versions), spec) ?? abbreviated.distTags[spec] ?? null;
    if (version && abbreviated.versions[version]?.hasInstallScript) hasInstallScript = true;
  }

  if (!version) return { version: null, manifest: null, hasInstallScript, checked: false };

  // The single-version document is small and carries license, scripts and the
  // deprecation notice — everything left that the audit needs.
  const manifest = await getVersionManifest(name, version, { timeoutMs: FANOUT_TIMEOUT_MS }).catch(() => null);
  if (manifest?.hasInstallScript === true) hasInstallScript = true;

  return { version, manifest, hasInstallScript, checked: manifest !== null };
}

export async function auditDependencies(args: AuditDependenciesInput): Promise<AuditDependenciesResult> {
  let parsed: ParsedManifest;
  try {
    parsed = parseManifest(args.manifest, { includeDev: args.includeDev });
  } catch (err) {
    if (err instanceof ManifestParseError) throw new ToolError('INVALID_INPUT', err.message);
    throw err;
  }

  const totalDeclared = parsed.dependencies.length;
  const selected = parsed.dependencies.slice(0, args.maxDependencies);
  const truncated = totalDeclared > selected.length;

  // Pass 1: resolve versions and gather registry facts.
  const inspected = await mapLimit(selected, DEFAULT_CONCURRENCY, async (dependency) => ({
    dependency,
    ...(await inspectOne(dependency.name, dependency.spec, dependency.exact)),
  }));

  // Pass 1b: the fan-out budget is deliberately tight, so a handful of requests
  // time out under load. Those few get a second chance with a longer budget and
  // lower concurrency — far cheaper than reporting their status as unknown.
  const stragglers = inspected.filter((entry) => !entry.checked && entry.version !== null);
  if (stragglers.length > 0) {
    await mapLimit(stragglers, 3, async (entry) => {
      const manifest = await getVersionManifest(entry.dependency.name, entry.version!).catch(() => null);
      if (manifest) {
        entry.manifest = manifest;
        entry.checked = true;
        if (manifest.hasInstallScript === true) entry.hasInstallScript = true;
      }
    });
  }

  // Pass 2: one batch request screens everything that resolved to a version.
  const targets = inspected
    .filter((entry): entry is typeof entry & { version: string } => entry.version !== null)
    .map((entry) => ({ name: entry.dependency.name, version: entry.version }));

  const screening = await optional('OSV', () => screenOsvBatch(targets));
  const affected = screening.value ?? new Map<string, string[]>();

  // Pass 3: full advisory detail, but only for the few that are actually hit.
  const detailed = new Map<string, Awaited<ReturnType<typeof queryOsv>>>();
  await mapLimit([...affected.keys()], DEFAULT_CONCURRENCY, async (key) => {
    const separator = key.lastIndexOf('@');
    const name = key.slice(0, separator);
    const version = key.slice(separator + 1);
    const report = await queryOsv(name, version).catch(() => null);
    if (report) detailed.set(key, report);
  });

  const dependencies: AuditedDependency[] = inspected.map((entry) => {
    const { dependency, version, manifest, hasInstallScript } = entry;
    const key = version ? `${dependency.name}@${version}` : null;
    const report = key ? detailed.get(key) : undefined;

    const issues: AuditIssue[] = [];
    const installScripts = INSTALL_HOOKS.filter((hook) => Boolean(manifest?.scripts?.[hook]));
    if (installScripts.length === 0 && hasInstallScript) installScripts.push('install');

    if (version === null) {
      issues.push({
        kind: 'unresolved',
        severity: 'info',
        detail: `Could not resolve "${dependency.spec}" to a published version.`,
      });
    }

    for (const advisory of report?.advisories ?? []) {
      issues.push({
        kind: 'vulnerability',
        severity: advisory.severity ?? 'info',
        detail: `${advisory.id}: ${advisory.summary ?? 'no summary'}`,
      });
    }

    const deprecated = manifest?.deprecated ?? null;
    if (deprecated) {
      issues.push({ kind: 'deprecated', severity: 'medium', detail: `Deprecated: ${truncate(deprecated, 200)}` });
    }

    if (installScripts.length > 0) {
      issues.push({
        kind: 'install-script',
        severity: 'low',
        detail: `Runs ${installScripts.join(', ')} on install.`,
      });
    }

    // Only judge the licence when we actually read the manifest. Reporting a
    // timed-out lookup as "no license declared" would be a fabricated finding.
    const license = entry.checked ? normalizeLicense(manifest?.license ?? null) : null;
    if (entry.checked) {
      const licenseFinding = licenseIssue(license);
      if (licenseFinding) issues.push(licenseFinding);
    } else if (version !== null) {
      issues.push({
        kind: 'unresolved',
        severity: 'info',
        detail: 'Registry metadata could not be fetched, so deprecation, install scripts and license were not checked.',
      });
    }

    // The lowest version clearing everything is the least disruptive upgrade.
    const fixes = report?.suggestedFixVersions ?? [];

    return {
      name: dependency.name,
      spec: dependency.spec,
      version,
      kind: dependency.kind,
      clean: issues.length === 0,
      issues,
      vulnerabilities: report?.advisories ?? [],
      highestSeverity: report?.highestSeverity ?? null,
      recommendedUpgrade: fixes.length > 0 ? (fixes[fixes.length - 1] ?? null) : null,
      deprecated,
      installScripts,
      license,
      metadataChecked: entry.checked,
    };
  });

  const severityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const dependency of dependencies) {
    for (const advisory of dependency.vulnerabilities) {
      if (advisory.severity && advisory.severity !== 'none') severityCounts[advisory.severity] += 1;
      else severityCounts.unknown += 1;
    }
  }

  const counts = {
    clean: dependencies.filter((dependency) => dependency.clean).length,
    vulnerable: dependencies.filter((dependency) => dependency.vulnerabilities.length > 0).length,
    deprecated: dependencies.filter((dependency) => dependency.deprecated !== null).length,
    withInstallScripts: dependencies.filter((dependency) => dependency.installScripts.length > 0).length,
    licenseIssues: dependencies.filter((dependency) => dependency.issues.some((issue) => issue.kind === 'license')).length,
    unchecked: dependencies.filter((dependency) => !dependency.metadataChecked).length,
  };

  const highestSeverity = highestRating(dependencies.map((dependency) => dependency.highestSeverity));

  const verdict =
    counts.vulnerable > 0
      ? `${counts.vulnerable} vulnerable ${counts.vulnerable === 1 ? 'dependency' : 'dependencies'} (highest severity ${highestSeverity ?? 'unknown'})`
      : counts.deprecated > 0 || counts.withInstallScripts > 0
        ? `no known vulnerabilities, but ${counts.deprecated} deprecated and ${counts.withInstallScripts} running install scripts`
        : 'no significant findings';

  const notes = [screening.note].filter((note): note is string => note !== null);
  if (screening.note) notes.push('Vulnerability results are incomplete because OSV could not be reached.');
  if (counts.unchecked > 0) {
    notes.push(
      `Registry metadata could not be read for ${counts.unchecked} of ${dependencies.length} dependencies ` +
        '(usually a timeout under load). Their deprecation, install-script and license status is unknown, not clean — ' +
        're-run to check them.',
    );
  }

  return {
    project: { name: parsed.projectName, version: parsed.projectVersion },
    source: parsed.source,
    lockfileVersion: parsed.lockfileVersion,
    transitive: parsed.transitive,
    includeDev: args.includeDev,
    verdict,
    audited: dependencies.length,
    totalDeclared,
    truncated,
    counts,
    severityCounts,
    highestSeverity,
    actions: buildActions(dependencies),
    dependencies,
    skipped: parsed.skipped,
    notes,
  };
}

export const auditDependenciesTool = defineTool({
  name: 'audit_dependencies',
  title: 'Audit a whole project',
  description:
    'Audit an entire project at once from its package.json or package-lock.json. Screens every dependency for known ' +
    'vulnerabilities in a single OSV batch request, then reports deprecated packages, packages that run install ' +
    'scripts, licence problems, and unresolvable specifiers — ending with a prioritised "fix these first" list. Use ' +
    'this whenever a user asks to check, audit, or review their dependencies, asks "is my project safe", or shares a ' +
    'package.json or lockfile. Pass the file contents as text (this server never reads the filesystem); a lockfile ' +
    'gives a better audit than a package.json because it pins exact versions and covers the whole installed tree.',
  inputSchema,
  input,
  handler: async (args) => {
    const result = await auditDependencies(args);
    return toolText(buildSummary(result), result, result.notes);
  }
});
