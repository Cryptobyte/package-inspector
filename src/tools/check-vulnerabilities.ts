import { z } from 'zod';
import { getPackument, resolveVersion } from '../lib/npm.js';
import { queryOsv, type Advisory } from '../lib/osv.js';
import { maxSatisfying, sortDescending } from '../lib/semver.js';
import { lines } from '../lib/format.js';
import { toolText } from '../lib/response.js';
import { defineTool, packageNameSchema, versionSchema, type JsonSchemaObject } from './types.js';

const input = z.object({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(128).optional(),
});

export type CheckVulnerabilitiesInput = z.infer<typeof input>;

const inputSchema: JsonSchemaObject = {
  type: 'object',
  properties: { name: packageNameSchema, version: versionSchema },
  required: ['name'],
  additionalProperties: false,
};

export interface CheckVulnerabilitiesResult {
  name: string;
  requestedVersion: string;
  resolvedVersion: string;
  latestVersion: string | null;
  verdict: string;
  clean: boolean;
  totalAdvisories: number;
  highestSeverity: string | null;
  severityCounts: Record<string, number>;
  advisories: Advisory[];
  safeUpgradeVersions: string[];
  recommendedUpgrade: string | null;
  source: string;
}

const SEVERITY_ICON: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
};

function buildSummary(result: CheckVulnerabilitiesResult): string {
  if (result.clean) {
    return lines(
      `✅ ${result.name}@${result.resolvedVersion} — no known vulnerabilities in the OSV database.`,
      result.resolvedVersion !== result.latestVersion && result.latestVersion
        ? `(Latest published version is ${result.latestVersion}.)`
        : null,
      'Note: "no known vulnerabilities" means none have been reported, not that the code is audited.'
    );
  }

  const advisoryLines = result.advisories
    .slice(0, 10)
    .map((advisory) => {
      const icon = advisory.severity ? (SEVERITY_ICON[advisory.severity] ?? '⚪') : '⚪';
      const score = advisory.cvssScore !== null ? ` CVSS ${advisory.cvssScore}` : '';
      const fix = advisory.fixedVersions.length > 0 ? ` → fixed in ${advisory.fixedVersions.join(', ')}` : ' → no fix published';
      return `${icon} ${advisory.id}${advisory.cve && advisory.cve !== advisory.id ? ` (${advisory.cve})` : ''} [${
        advisory.severity ?? 'unknown'
      }${score}]\n   ${advisory.summary ?? 'No summary provided.'}${fix}`;
    })
    .join('\n');

  return lines(
    `⚠️ ${result.name}@${result.resolvedVersion} — ${result.verdict}`,
    result.recommendedUpgrade
      ? `Recommended fix: upgrade to ${result.recommendedUpgrade} (clears every advisory listed below).`
      : 'No single published version clears every advisory; review each one individually.',
    '',
    advisoryLines,
    result.advisories.length > 10 ? `\n… and ${result.advisories.length - 10} more (see JSON).` : null,
  );
}

export function findSafeVersions(
  publishedVersions: readonly string[],
  advisories: readonly Advisory[],
): string[] {
  if (advisories.length === 0) return [];
  if (advisories.some((advisory) => advisory.fixedVersions.length === 0)) return [];

  const safe = publishedVersions.filter((version) =>
    advisories.every((advisory) =>
      advisory.fixedVersions.some((fix) => {
        const matched = maxSatisfying([version], `>=${fix}`);
        return matched !== null;
      })
    )
  );

  return sortDescending(safe);
}

export async function checkVulnerabilities(args: CheckVulnerabilitiesInput): Promise<CheckVulnerabilitiesResult> {
  const packument = await getPackument(args.name);
  const resolved = resolveVersion(packument, args.version);
  const report = await queryOsv(packument.name, resolved.version);

  const safeUpgradeVersions = findSafeVersions(packument.versions, report.advisories).filter(
    (version) => maxSatisfying([version], `>${resolved.version}`) !== null
  );

  const clean = report.advisories.length === 0;
  const count = report.advisories.length;
  const verdict = clean
    ? 'clean — no known vulnerabilities'
    : `${count} known ${count === 1 ? 'vulnerability' : 'vulnerabilities'}, highest severity: ${report.highestSeverity ?? 'unknown'}`;

  return {
    name: packument.name,
    requestedVersion: resolved.requested,
    resolvedVersion: resolved.version,
    latestVersion: packument.distTags.latest ?? null,
    verdict,
    clean,
    totalAdvisories: report.advisories.length,
    highestSeverity: report.highestSeverity,
    severityCounts: report.counts,
    advisories: report.advisories,
    safeUpgradeVersions: safeUpgradeVersions.slice(0, 20),
    recommendedUpgrade: safeUpgradeVersions.length > 0 ? (safeUpgradeVersions[safeUpgradeVersions.length - 1] ?? null) : null,
    source: 'https://osv.dev'
  };
}

export const checkVulnerabilitiesTool = defineTool({
  name: 'check_vulnerabilities',
  title: 'Check known vulnerabilities',
  description:
    'Query the OSV database (GitHub Security Advisories, npm advisories, CVEs) for known vulnerabilities affecting a ' +
    'specific package version. Returns each advisory with its GHSA/CVE id, summary, CVSS severity score, affected ' +
    'version ranges and fixed versions, plus an overall verdict and the smallest upgrade that clears everything. ' +
    'Use this whenever a user asks "is X safe", "does X have CVEs", "should I upgrade X", or before recommending a ' +
    'pinned version.',
  inputSchema,
  input,
  handler: async (args) => {
    const result = await checkVulnerabilities(args);
    
    return toolText(buildSummary(result), result);
  }
});
