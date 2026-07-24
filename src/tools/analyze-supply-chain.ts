import { z } from 'zod';
import {
  getAttestations,
  getDownloadPoint,
  getPackument,
  getVersionManifest,
  normalizeLicense,
  resolveVersion

} from '../lib/npm.js';

import { queryOsv } from '../lib/osv.js';
import { optional } from '../lib/errors.js';
import { findTyposquatMatches, type TyposquatMatch } from '../lib/typosquat.js';
import { daysBetween, humanCount, lines, normalizeRepositoryUrl, relativeTime } from '../lib/format.js';
import { toolText } from '../lib/response.js';
import { defineTool, packageNameSchema, versionSchema, type JsonSchemaObject } from './types.js';

const input = z.object({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(128).optional()
});

export type AnalyzeSupplyChainInput = z.infer<typeof input>;

const inputSchema: JsonSchemaObject = {
  type: 'object',
  properties: { name: packageNameSchema, version: versionSchema },
  required: ['name'],
  additionalProperties: false
};

export type RiskLevel = 'low' | 'medium' | 'high';
export type SignalSeverity = 'info' | 'low' | 'medium' | 'high';

export interface RiskSignal {
  id: string;
  severity: SignalSeverity;
  weight: number;
  title: string;
  detail: string;
}

const RECOGNIZED_LICENSES = new Set([
  'MIT',
  'ISC',
  'APACHE-2.0',
  'BSD-2-CLAUSE',
  'BSD-3-CLAUSE',
  'BSD-3-CLAUSE-CLEAR',
  '0BSD',
  'UNLICENSE',
  'CC0-1.0',
  'MPL-2.0',
  'LGPL-2.1',
  'LGPL-2.1-ONLY',
  'LGPL-2.1-OR-LATER',
  'LGPL-3.0',
  'LGPL-3.0-ONLY',
  'LGPL-3.0-OR-LATER',
  'GPL-2.0',
  'GPL-2.0-ONLY',
  'GPL-2.0-OR-LATER',
  'GPL-3.0',
  'GPL-3.0-ONLY',
  'GPL-3.0-OR-LATER',
  'AGPL-3.0',
  'AGPL-3.0-ONLY',
  'AGPL-3.0-OR-LATER',
  'ARTISTIC-2.0',
  'ZLIB',
  'PYTHON-2.0',
  'BSL-1.0',
  'EPL-1.0',
  'EPL-2.0',
  'CDDL-1.0',
  'WTFPL',
  'BLUEOAK-1.0.0',
  'BSD',
  'BSD-4-CLAUSE',
  'MIT-0',
  'POSTGRESQL',
  'NCSA',
  'UPL-1.0',
  'MS-PL'
]);

const STRONG_COPYLEFT = /^(A?GPL|LGPL)/;
const INSTALL_SCRIPT_HOOKS = ['preinstall', 'install', 'postinstall'] as const;

export const RISK_THRESHOLDS = { medium: 20, high: 50 } as const;

export function levelFromScore(score: number): RiskLevel {
  if (score >= RISK_THRESHOLDS.high) return 'high';
  if (score >= RISK_THRESHOLDS.medium) return 'medium';
  return 'low';
}

export interface SupplyChainResult {
  name: string;
  requestedVersion: string;
  resolvedVersion: string;
  riskLevel: RiskLevel;
  riskScore: number;
  verdict: string;
  signals: RiskSignal[];
  mitigations: RiskSignal[];
  facts: {
    weeklyDownloads: number | null;
    maintainerCount: number;
    maintainers: string[];
    lastPublisher: string | null;
    publishedAt: string | null;
    daysSincePublish: number | null;
    packageAgeDays: number | null;
    totalVersions: number;
    license: string | null;
    repository: string | null;
    deprecated: string | null;
    installScripts: Record<string, string>;
    allScriptNames: string[];
    provenance: { present: boolean; hasProvenance: boolean; hasPublishAttestation: boolean; predicateTypes: string[] };
    integrity: { hasIntegrity: boolean; hasRegistrySignature: boolean };
    typosquatMatches: TyposquatMatch[];
    knownVulnerabilities: { count: number; highestSeverity: string | null } | null;
  };

  notes: string[];
}

export function scoreSignals(facts: SupplyChainResult['facts'], packageName: string): RiskSignal[] {
  const signals: RiskSignal[] = [];
  const downloads = facts.weeklyDownloads;
  const wellAdopted = downloads !== null && downloads >= 100_000;
  const hooks = Object.keys(facts.installScripts);

  if (hooks.length > 0) {
    signals.push({
      id: 'install-scripts',
      severity: 'high',
      weight: 25,
      title: 'Runs scripts at install time',
      detail:
        `Defines ${hooks.join(', ')}, which execute automatically on \`npm install\` unless --ignore-scripts is used. ` +
        hooks.map((hook) => `${hook}: "${facts.installScripts[hook]}"`).join(' | ')
    });
  }

  if (facts.deprecated) {
    signals.push({
      id: 'deprecated',
      severity: 'high',
      weight: 20,
      title: 'Version is deprecated',
      detail: `The maintainers marked this version deprecated: "${facts.deprecated}"`
    });
  }

  if (facts.maintainerCount === 0) {
    signals.push({
      id: 'no-maintainers',
      severity: 'high',
      weight: 15,
      title: 'No maintainers listed',
      detail: 'The registry lists no maintainers for this package, which is unusual and worth investigating.'
    });

  } else if (facts.maintainerCount === 1) {
    signals.push({
      id: 'single-maintainer',
      severity: wellAdopted ? 'low' : 'medium',
      weight: wellAdopted ? 5 : 12,
      title: 'Single maintainer (bus factor 1)',
      detail:
        `Only ${facts.maintainers[0] ?? 'one account'} can publish. A compromise of that one account compromises ` +
        `every consumer.${wellAdopted ? ' Mitigated somewhat by heavy adoption and scrutiny.' : ''}`
    });
  }

  if (facts.daysSincePublish !== null) {
    if (facts.daysSincePublish > 730) {
      signals.push({
        id: 'stale',
        severity: 'medium',
        weight: 10,
        title: 'No release in over two years',
        detail: `This version was published ${facts.daysSincePublish} days ago and nothing newer has shipped. Security fixes are unlikely to arrive.`
      });

    } else if (facts.daysSincePublish <= 7 && facts.packageAgeDays !== null && facts.packageAgeDays <= 30) {
      signals.push({
        id: 'brand-new',
        severity: 'medium',
        weight: 12,
        title: 'Very new package',
        detail: `The package itself is only ${facts.packageAgeDays} days old and this version landed ${facts.daysSincePublish} days ago. New packages have had little time to be scrutinised.`
      });

    } else if (facts.daysSincePublish <= 2) {
      signals.push({
        id: 'just-published',
        severity: 'info',
        weight: 3,
        title: 'Published within the last 48 hours',
        detail: 'Very recent publishes have had minimal community review. Not a problem by itself.'
      });
    }
  }

  if (facts.provenance.hasProvenance) {
    signals.push({
      id: 'has-provenance',
      severity: 'info',
      weight: -10,
      title: 'Signed build provenance present',
      detail: `npm holds a verifiable attestation linking this tarball to its source build (${facts.provenance.predicateTypes.join(', ')}).`,
    });

  } else {
    signals.push({
      id: 'no-provenance',
      severity: 'info',
      weight: 4,
      title: 'No build provenance',
      detail:
        'No SLSA provenance attestation was published, so the tarball cannot be traced to a specific source commit ' +
        'and CI run. This is still the norm on npm — a weak signal, not a finding.'
    });
  }

  if (!facts.integrity.hasRegistrySignature) {
    signals.push({
      id: 'no-registry-signature',
      severity: 'low',
      weight: 3,
      title: 'No registry signature on the tarball',
      detail: 'The dist entry carries no npm ECDSA signature, so `npm audit signatures` cannot verify it.'
    });
  }

  const license = facts.license;

  if (!license) {
    signals.push({
      id: 'no-license',
      severity: 'high',
      weight: 15,
      title: 'No license declared',
      detail: 'Without a license, default copyright applies and you have no legal right to use or redistribute this code.'
    });

  } else {
    const normalized = license.trim().toUpperCase();

    if (normalized === 'UNLICENSED' || normalized.startsWith('SEE LICENSE')) {
      signals.push({
        id: 'nonstandard-license',
        severity: 'medium',
        weight: 12,
        title: `Non-standard license: ${license}`,
        detail: 'The license is not a recognised SPDX identifier; read the terms before depending on this package.'
      });

    } else if (!RECOGNIZED_LICENSES.has(normalized) && !normalized.includes(' OR ') && !normalized.includes(' AND ')) {
      signals.push({
        id: 'unrecognized-license',
        severity: 'low',
        weight: 6,
        title: `Unrecognised license identifier: ${license}`,
        detail: 'This is not in the list of common OSI-approved identifiers. It may be valid but unusual, or a typo.'
      });

    } else if (STRONG_COPYLEFT.test(normalized)) {
      signals.push({
        id: 'copyleft-license',
        severity: 'low',
        weight: 5,
        title: `Copyleft license: ${license}`,
        detail: 'Legitimate open source, but it imposes obligations that may be incompatible with proprietary distribution.'
      });
    }
  }

  if (!facts.repository) {
    signals.push({
      id: 'no-repository',
      severity: 'medium',
      weight: 8,
      title: 'No source repository declared',
      detail: 'There is no repository field, so the published code cannot be compared against public source.'
    });
  }

  if (downloads !== null && downloads < 100) {
    signals.push({
      id: 'very-low-adoption',
      severity: 'medium',
      weight: 8,
      title: 'Almost no adoption',
      detail: `Only ${humanCount(downloads)} downloads in the last week. Very few people have looked at this code.`
    });
  }

  if (facts.typosquatMatches.length > 0) {
    const closest = facts.typosquatMatches[0]!;
    const targets = facts.typosquatMatches
      .slice(0, 3)
      .map((match) => `"${match.target}" (${match.technique}, distance ${match.distance})`)
      .join(', ');

    if (wellAdopted) {
      signals.push({
        id: 'similar-name-established',
        severity: 'info',
        weight: 0,
        title: 'Name resembles a popular package, but this package is itself established',
        detail: `"${packageName}" is close to ${targets}, however ${humanCount(downloads)} weekly downloads indicate a legitimate, widely used package rather than an impersonation.`
      });

    } else {
      const severe = closest.technique !== 'edit-distance' || closest.distance <= 1;

      signals.push({
        id: 'possible-typosquat',
        severity: severe ? 'high' : 'medium',
        weight: severe ? 30 : 18,
        title: 'Name closely resembles a very popular package',
        detail:
          `"${packageName}" is a near-match for ${targets}. Combined with ${
            downloads === null ? 'unknown' : humanCount(downloads)
          } weekly downloads, this is a classic typosquatting pattern. Confirm you meant this exact name.`
      });
    }
  }

  if (facts.knownVulnerabilities && facts.knownVulnerabilities.count > 0) {
    const severity = facts.knownVulnerabilities.highestSeverity;
    const weight = severity === 'critical' ? 25 : severity === 'high' ? 18 : severity === 'medium' ? 10 : 5;

    signals.push({
      id: 'known-vulnerabilities',
      severity: severity === 'critical' || severity === 'high' ? 'high' : 'medium',
      weight,
      title: `${facts.knownVulnerabilities.count} known vulnerability/vulnerabilities`,
      detail: `OSV reports advisories affecting this exact version, highest severity ${severity ?? 'unknown'}. Run check_vulnerabilities for the details.`
    });
  }

  return signals;
}

const SEVERITY_ICON: Record<SignalSeverity, string> = { high: '🔴', medium: '🟠', low: '🟡', info: 'ℹ️' };

function buildSummary(result: SupplyChainResult): string {
  const icon = result.riskLevel === 'high' ? '🔴' : result.riskLevel === 'medium' ? '🟠' : '🟢';
  const findings = result.signals
    .map((signal) => `${SEVERITY_ICON[signal.severity]} ${signal.title} (+${signal.weight})\n   ${signal.detail}`)
    .join('\n');

  const mitigations = result.mitigations
    .map((signal) => `✅ ${signal.title} (${signal.weight})\n   ${signal.detail}`)
    .join('\n');

  return lines(
    `${icon} ${result.name}@${result.resolvedVersion} — supply-chain risk: ${result.riskLevel.toUpperCase()} (score ${result.riskScore})`,
    result.verdict,
    '',
    `${humanCount(result.facts.weeklyDownloads)} weekly downloads · ${result.facts.maintainerCount} maintainer(s) · ` +
      `published ${relativeTime(result.facts.publishedAt)}${
        result.facts.lastPublisher ? ` by ${result.facts.lastPublisher}` : ''
      } · license ${result.facts.license ?? 'NONE'}`,
    '',
    findings ? `Findings:\n${findings}` : 'No risk signals found.',
    mitigations ? `\nMitigating factors:\n${mitigations}` : null
  );
}

function verdictFor(level: RiskLevel, signals: readonly RiskSignal[]): string {
  const top = signals.filter((signal) => signal.severity === 'high').map((signal) => signal.title);

  switch (level) {
    case 'high':
      return `Do not install without review. Primary concerns: ${top.join('; ') || 'multiple weighted signals'}.`;

    case 'medium':
      return `Usable with awareness. Worth a look: ${
        signals
          .filter((signal) => signal.severity !== 'info')
          .map((signal) => signal.title)
          .slice(0, 3)
          .join('; ') || 'see findings'
      }.`;

    case 'low':
      return 'No significant supply-chain concerns found in the available metadata.';
  }
}

export async function analyzeSupplyChain(args: AnalyzeSupplyChainInput): Promise<SupplyChainResult> {
  const packument = await getPackument(args.name);
  const resolved = resolveVersion(packument, args.version);
  const manifest = await getVersionManifest(packument.name, resolved.version);

  const [downloads, attestations, vulns] = await Promise.all([
    optional('npm downloads', () => getDownloadPoint(packument.name, 'last-week')),
    optional('npm attestations', () => getAttestations(packument.name, resolved.version)),
    optional('OSV', () => queryOsv(packument.name, resolved.version))
  ]);

  const installScripts: Record<string, string> = {};
  for (const hook of INSTALL_SCRIPT_HOOKS) {
    const script = manifest.scripts?.[hook];

    if (typeof script === 'string' && script.trim() !== '') {
      installScripts[hook] = script;
    }
  }
  
  if (Object.keys(installScripts).length === 0 && manifest.hasInstallScript === true) {
    installScripts.install = '(declared via hasInstallScript; script body not exposed by the registry)';
  }

  const publishedAt = packument.time[resolved.version] ?? null;
  const createdAt = packument.time.created ?? null;
  const maintainers = (manifest.maintainers ?? packument.maintainers).map((person) => person.name).filter(Boolean);

  const facts: SupplyChainResult['facts'] = {
    weeklyDownloads: downloads.value?.downloads ?? null,
    maintainerCount: maintainers.length,
    maintainers,
    lastPublisher: manifest._npmUser?.name ?? null,
    publishedAt,
    daysSincePublish: publishedAt ? daysBetween(publishedAt, new Date()) : null,
    packageAgeDays: createdAt ? daysBetween(createdAt, new Date()) : null,
    totalVersions: packument.versions.length,
    license: normalizeLicense(manifest.license ?? packument.license),
    repository: normalizeRepositoryUrl(manifest.repository ?? packument.repository),
    deprecated: packument.deprecatedVersions[resolved.version] ?? null,
    installScripts,
    allScriptNames: Object.keys(manifest.scripts ?? {}),
    provenance: {
      present: attestations.value?.present ?? false,
      hasProvenance: attestations.value?.hasProvenance ?? false,
      hasPublishAttestation: attestations.value?.hasPublishAttestation ?? false,
      predicateTypes: attestations.value?.predicateTypes ?? []
    },
    integrity: {
      hasIntegrity: typeof manifest.dist?.integrity === 'string',
      hasRegistrySignature: (manifest.dist?.signatures?.length ?? 0) > 0
    },
    typosquatMatches: findTyposquatMatches(packument.name),
    knownVulnerabilities: vulns.value
      ? { count: vulns.value.advisories.length, highestSeverity: vulns.value.highestSeverity }
      : null
  };

  const allSignals = scoreSignals(facts, packument.name);
  const signals = allSignals.filter((signal) => signal.weight > 0);
  const mitigations = allSignals.filter((signal) => signal.weight < 0);

  const riskScore = Math.max(0, allSignals.reduce((sum, signal) => sum + signal.weight, 0));
  const riskLevel = levelFromScore(riskScore);

  const notes = [downloads.note, attestations.note, vulns.note].filter((note): note is string => note !== null);

  return {
    name: packument.name,
    requestedVersion: resolved.requested,
    resolvedVersion: resolved.version,
    riskLevel,
    riskScore,
    verdict: verdictFor(riskLevel, signals),
    signals: signals.sort((a, b) => b.weight - a.weight),
    mitigations,
    facts,
    notes
  };
}

export const analyzeSupplyChainTool = defineTool({
  name: 'analyze_supply_chain',
  title: 'Analyze supply-chain risk',
  description:
    'Produce a weighted, explainable supply-chain risk report for a package version. Checks install/preinstall/' +
    'postinstall scripts, maintainer bus factor, publish recency and account, build provenance and registry ' +
    'signatures, deprecation, license risk (missing, non-OSI, or copyleft), adoption level, known vulnerabilities, and ' +
    'typosquatting similarity against a built-in list of very popular packages. Returns low/medium/high with the ' +
    'specific reasons behind it. Use this before adding an unfamiliar dependency, when a package name looks slightly ' +
    'off, or when a user asks "can I trust this package".',
  inputSchema,
  input,
  handler: async (args) => {
    const result = await analyzeSupplyChain(args);

    return toolText(buildSummary(result), result, result.notes);
  }
});
