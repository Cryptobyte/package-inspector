/**
 * CVSS v3.x base score calculation.
 *
 * OSV returns severity as a raw CVSS vector string; a bare vector is not very
 * useful to a model, so we compute the numeric base score and qualitative
 * rating locally. Implements the CVSS v3.1 specification, section 8.1.
 *
 * v4.0 vectors are recognised but not scored — the vector is passed through
 * unchanged and the caller falls back to the advisory's qualitative rating.
 */

export type CvssRating = 'none' | 'low' | 'medium' | 'high' | 'critical';

export interface CvssResult {
  version: string;
  vector: string;
  score: number | null;
  rating: CvssRating | null;
}

const AV: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC: Record<string, number> = { L: 0.77, H: 0.44 };
const PR_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const UI: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA: Record<string, number> = { H: 0.56, L: 0.22, N: 0.0 };

/** CVSS-specific rounding: always round *up* to one decimal place. */
export function roundUp1(value: number): number {
  const scaled = Math.round(value * 100_000);
  if (scaled % 10_000 === 0) return scaled / 100_000;
  return (Math.floor(scaled / 10_000) + 1) / 10;
}

export function ratingFor(score: number): CvssRating {
  if (score <= 0) return 'none';
  if (score < 4) return 'low';
  if (score < 7) return 'medium';
  if (score < 9) return 'high';
  return 'critical';
}

function parseVector(vector: string): Map<string, string> {
  const metrics = new Map<string, string>();
  for (const part of vector.split('/')) {
    const [key, value] = part.split(':');
    if (key && value) metrics.set(key.trim().toUpperCase(), value.trim().toUpperCase());
  }
  return metrics;
}

/**
 * Parses and scores a CVSS vector string.
 * Returns null when the string is not a recognisable CVSS vector.
 */
export function scoreCvss(vector: string): CvssResult | null {
  if (typeof vector !== 'string') return null;
  const trimmed = vector.trim();
  if (!trimmed.toUpperCase().startsWith('CVSS:')) return null;

  const metrics = parseVector(trimmed);
  const version = metrics.get('CVSS') ?? '';

  if (!version.startsWith('3.')) {
    // Recognised (e.g. CVSS:4.0) but not scored here.
    return { version, vector: trimmed, score: null, rating: null };
  }

  const av = AV[metrics.get('AV') ?? ''];
  const ac = AC[metrics.get('AC') ?? ''];
  const ui = UI[metrics.get('UI') ?? ''];
  const scope = metrics.get('S') ?? '';
  const conf = CIA[metrics.get('C') ?? ''];
  const integ = CIA[metrics.get('I') ?? ''];
  const avail = CIA[metrics.get('A') ?? ''];

  const scopeChanged = scope === 'C';
  const prTable = scopeChanged ? PR_CHANGED : PR_UNCHANGED;
  const pr = prTable[metrics.get('PR') ?? ''];

  if (
    av === undefined ||
    ac === undefined ||
    pr === undefined ||
    ui === undefined ||
    conf === undefined ||
    integ === undefined ||
    avail === undefined ||
    (scope !== 'C' && scope !== 'U')
  ) {
    return { version, vector: trimmed, score: null, rating: null };
  }

  const iss = 1 - (1 - conf) * (1 - integ) * (1 - avail);
  const impact = scopeChanged
    ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15)
    : 6.42 * iss;

  if (impact <= 0) {
    return { version, vector: trimmed, score: 0, rating: 'none' };
  }

  const exploitability = 8.22 * av * ac * pr * ui;
  const base = scopeChanged
    ? roundUp1(Math.min(1.08 * (impact + exploitability), 10))
    : roundUp1(Math.min(impact + exploitability, 10));

  return { version, vector: trimmed, score: base, rating: ratingFor(base) };
}

const RATING_ORDER: CvssRating[] = ['none', 'low', 'medium', 'high', 'critical'];

/** Normalises free-form severity words (GHSA uses MODERATE) to a CvssRating. */
export function normalizeRating(value: string | null | undefined): CvssRating | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  switch (upper) {
    case 'CRITICAL':
      return 'critical';
    case 'HIGH':
      return 'high';
    case 'MODERATE':
    case 'MEDIUM':
      return 'medium';
    case 'LOW':
      return 'low';
    case 'NONE':
    case 'UNKNOWN':
      return null;
    default:
      return null;
  }
}

/** Returns the most severe of the supplied ratings, or null if there are none. */
export function highestRating(ratings: ReadonlyArray<CvssRating | null>): CvssRating | null {
  let best = -1;
  for (const rating of ratings) {
    if (!rating) continue;
    const index = RATING_ORDER.indexOf(rating);
    if (index > best) best = index;
  }
  return best < 0 ? null : (RATING_ORDER[best] ?? null);
}

export function ratingRank(rating: CvssRating | null): number {
  return rating ? RATING_ORDER.indexOf(rating) : -1;
}
