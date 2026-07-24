/**
 * OSV.dev vulnerability client.
 *
 * OSV aggregates GitHub Security Advisories, the npm advisory database and
 * others behind a single free, unauthenticated API. We POST the exact resolved
 * version and let OSV do the range matching.
 */

import { cached, DEFAULT_TTL_MS, fetchJson } from './http.js';
import { highestRating, normalizeRating, ratingRank, scoreCvss, type CvssRating } from './cvss.js';
import { truncate } from './format.js';

const OSV_ENDPOINT = 'https://api.osv.dev/v1/query';
const OSV_BATCH_ENDPOINT = 'https://api.osv.dev/v1/querybatch';
/** OSV caps a batch; chunking keeps large lockfiles within it. */
const OSV_BATCH_CHUNK = 500;

interface OsvSeverity {
  type?: string;
  score?: string;
}

interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

interface OsvRange {
  type?: string;
  events?: OsvEvent[];
}

interface OsvAffected {
  package?: { name?: string; ecosystem?: string };
  ranges?: OsvRange[];
  versions?: string[];
  severity?: OsvSeverity[];
  database_specific?: { severity?: string; [key: string]: unknown };
  ecosystem_specific?: { severity?: string; [key: string]: unknown };
}

interface OsvVuln {
  id?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  modified?: string;
  published?: string;
  withdrawn?: string;
  severity?: OsvSeverity[];
  affected?: OsvAffected[];
  references?: Array<{ type?: string; url?: string }>;
  database_specific?: { severity?: string; cwe_ids?: string[]; [key: string]: unknown };
}

export interface AffectedRange {
  /** Human form of the range, e.g. `>=1.0.0 <1.4.2`. */
  range: string;
  introduced: string | null;
  fixed: string | null;
}

export interface Advisory {
  id: string;
  /** CVE / GHSA identifiers for the same issue. */
  aliases: string[];
  /** The CVE id if one exists, for convenience. */
  cve: string | null;
  summary: string | null;
  details: string | null;
  severity: CvssRating | null;
  cvssScore: number | null;
  cvssVector: string | null;
  cwes: string[];
  published: string | null;
  modified: string | null;
  affectedRanges: AffectedRange[];
  /** Every fixed version mentioned across the affected ranges. */
  fixedVersions: string[];
  references: string[];
}

export interface VulnerabilityReport {
  advisories: Advisory[];
  highestSeverity: CvssRating | null;
  /** Count of advisories per severity bucket. */
  counts: Record<'critical' | 'high' | 'medium' | 'low' | 'unknown', number>;
  /** Versions that resolve every advisory found, if such a version exists. */
  suggestedFixVersions: string[];
}

function formatRange(range: OsvRange): AffectedRange[] {
  const events = range.events ?? [];
  const out: AffectedRange[] = [];
  let introduced: string | null = null;

  for (const event of events) {
    if (typeof event.introduced === 'string') {
      introduced = event.introduced;
      continue;
    }
    const upper = event.fixed ?? event.last_affected ?? event.limit;
    if (typeof upper === 'string') {
      const lower = introduced === '0' || introduced === null ? null : introduced;
      const parts: string[] = [];
      if (lower) parts.push(`>=${lower}`);
      parts.push(event.fixed ? `<${event.fixed}` : `<=${upper}`);
      out.push({ range: parts.join(' '), introduced: lower, fixed: event.fixed ?? null });
      introduced = null;
    }
  }

  // An `introduced` with no matching upper bound means "everything since".
  if (introduced !== null) {
    const lower = introduced === '0' ? null : introduced;
    out.push({ range: lower ? `>=${lower}` : 'all versions', introduced: lower, fixed: null });
  }

  return out;
}

function pickSeverity(vuln: OsvVuln): { rating: CvssRating | null; score: number | null; vector: string | null } {
  const vectors = [...(vuln.severity ?? []), ...(vuln.affected ?? []).flatMap((a) => a.severity ?? [])];

  let bestScore: number | null = null;
  let bestVector: string | null = null;
  let bestRating: CvssRating | null = null;

  for (const entry of vectors) {
    if (typeof entry.score !== 'string') continue;
    const parsed = scoreCvss(entry.score);
    if (!parsed) continue;
    if (bestVector === null) bestVector = parsed.vector;
    if (parsed.score !== null && (bestScore === null || parsed.score > bestScore)) {
      bestScore = parsed.score;
      bestVector = parsed.vector;
      bestRating = parsed.rating;
    }
  }

  if (bestRating === null) {
    // Fall back to the qualitative rating databases attach (GHSA: MODERATE etc).
    const qualitative = [
      vuln.database_specific?.severity,
      ...(vuln.affected ?? []).map((a) => a.database_specific?.severity),
      ...(vuln.affected ?? []).map((a) => a.ecosystem_specific?.severity),
    ].map((value) => normalizeRating(typeof value === 'string' ? value : null));
    bestRating = highestRating(qualitative);
  }

  return { rating: bestRating, score: bestScore, vector: bestVector };
}

function toAdvisory(vuln: OsvVuln, packageName: string): Advisory {
  const aliases = Array.isArray(vuln.aliases) ? vuln.aliases : [];
  const relevant = (vuln.affected ?? []).filter(
    (entry) =>
      entry.package?.ecosystem?.toLowerCase() === 'npm' &&
      (entry.package?.name === undefined || entry.package.name === packageName),
  );
  const affectedEntries = relevant.length > 0 ? relevant : (vuln.affected ?? []);

  const affectedRanges = affectedEntries.flatMap((entry) => (entry.ranges ?? []).flatMap(formatRange));
  const fixedVersions = [
    ...new Set(affectedRanges.map((range) => range.fixed).filter((value): value is string => value !== null)),
  ];

  const severity = pickSeverity(vuln);
  const cwesRaw = vuln.database_specific?.cwe_ids;

  return {
    id: vuln.id ?? 'UNKNOWN',
    aliases,
    cve: aliases.find((alias) => alias.startsWith('CVE-')) ?? (vuln.id?.startsWith('CVE-') ? vuln.id : null),
    summary: truncate(vuln.summary, 300),
    details: truncate(vuln.details, 600),
    severity: severity.rating,
    cvssScore: severity.score,
    cvssVector: severity.vector,
    cwes: Array.isArray(cwesRaw) ? cwesRaw.filter((value): value is string => typeof value === 'string') : [],
    published: vuln.published ?? null,
    modified: vuln.modified ?? null,
    affectedRanges,
    fixedVersions,
    references: (vuln.references ?? [])
      .map((reference) => reference?.url)
      .filter((url): url is string => typeof url === 'string')
      .slice(0, 5),
  };
}

/** Builds the severity histogram and picks the best overall fix suggestion. */
export function summarizeAdvisories(advisories: readonly Advisory[]): VulnerabilityReport {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const advisory of advisories) {
    if (advisory.severity && advisory.severity !== 'none') counts[advisory.severity] += 1;
    else counts.unknown += 1;
  }

  // A version that appears as a fix for every advisory clears the whole set.
  const fixSets = advisories.map((advisory) => new Set(advisory.fixedVersions));
  const suggestedFixVersions =
    advisories.length > 0 && fixSets.every((set) => set.size > 0)
      ? [...(fixSets[0] ?? [])].filter((version) => fixSets.every((set) => set.has(version)))
      : [];

  return {
    advisories: [...advisories].sort((a, b) => ratingRank(b.severity) - ratingRank(a.severity)),
    highestSeverity: highestRating(advisories.map((advisory) => advisory.severity)),
    counts,
    suggestedFixVersions,
  };
}

/**
 * Queries OSV for advisories affecting an exact version.
 * Withdrawn advisories are filtered out.
 */
export async function queryOsv(name: string, version: string): Promise<VulnerabilityReport> {
  return cached(`osv:${name}@${version}`, DEFAULT_TTL_MS, async () => {
    const raw = await fetchJson<{ vulns?: OsvVuln[] }>(OSV_ENDPOINT, {
      method: 'POST',
      body: { package: { name, ecosystem: 'npm' }, version },
      source: 'OSV',
    });

    const vulns = (raw?.vulns ?? []).filter((vuln) => !vuln.withdrawn);
    return summarizeAdvisories(vulns.map((vuln) => toAdvisory(vuln, name)));
  });
}

// ---------------------------------------------------------------------------
// Batch screening
// ---------------------------------------------------------------------------

export interface BatchTarget {
  name: string;
  version: string;
}

/**
 * Screens many packages for advisories in a single request.
 *
 * The batch endpoint deliberately returns an *index* — advisory ids only, no
 * summaries or severities. That is exactly what an audit wants for the first
 * pass: most dependencies are clean, so this identifies the handful that are
 * not, and only those need a full `queryOsv` to be described properly.
 *
 * Returns a map of `name@version` to the advisory ids affecting it. Packages
 * with no advisories are absent from the map.
 */
export async function screenOsvBatch(targets: readonly BatchTarget[]): Promise<Map<string, string[]>> {
  const affected = new Map<string, string[]>();
  if (targets.length === 0) return affected;

  for (let offset = 0; offset < targets.length; offset += OSV_BATCH_CHUNK) {
    const chunk = targets.slice(offset, offset + OSV_BATCH_CHUNK);

    const raw = await fetchJson<{ results?: Array<{ vulns?: Array<{ id?: string }> }> }>(OSV_BATCH_ENDPOINT, {
      method: 'POST',
      body: {
        queries: chunk.map((target) => ({
          package: { name: target.name, ecosystem: 'npm' },
          version: target.version,
        })),
      },
      source: 'OSV',
      // A batch of 500 is more work for OSV than a single query.
      timeoutMs: 20_000,
    });

    // Results are positional: index i corresponds to queries[i].
    const results = raw?.results ?? [];
    chunk.forEach((target, index) => {
      const ids = (results[index]?.vulns ?? [])
        .map((vuln) => vuln?.id)
        .filter((id): id is string => typeof id === 'string');
      if (ids.length > 0) affected.set(`${target.name}@${target.version}`, ids);
    });
  }

  return affected;
}
