/**
 * A focused, dependency-free implementation of the parts of semver this server
 * needs: parsing, comparison, and range matching for npm dependency ranges.
 *
 * Implemented here rather than pulling in `semver` so the published package has
 * exactly two runtime dependencies. Behaviour follows node-semver, including
 * the rule that prerelease versions only satisfy a range when a comparator in
 * the matching set pins the same [major, minor, patch] tuple.
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: ReadonlyArray<string | number>;
  build: string | null;
  raw: string;
  version: string;
}

const SEMVER_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-((?:\d+|\d*[a-zA-Z-][a-zA-Z0-9-]*)(?:\.(?:\d+|\d*[a-zA-Z-][a-zA-Z0-9-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const NUMERIC_RE = /^\d+$/;

/** Parses a strict semver string. Returns null for anything non-conforming. */
export function parse(input: string): SemVer | null {
  if (typeof input !== 'string') return null;
  const match = SEMVER_RE.exec(input.trim());
  if (!match) return null;

  const [, major, minor, patch, pre, build] = match;
  const prerelease: Array<string | number> = pre
    ? pre.split('.').map((part) => (NUMERIC_RE.test(part) ? Number(part) : part))
    : [];

  const version = `${Number(major)}.${Number(minor)}.${Number(patch)}${pre ? `-${pre}` : ''}`;

  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease,
    build: build ?? null,
    raw: input.trim(),
    version,
  };
}

export function isValid(input: string): boolean {
  return parse(input) !== null;
}

export function isPrerelease(input: string): boolean {
  const parsed = parse(input);
  return parsed !== null && parsed.prerelease.length > 0;
}

function compareIdentifiers(a: string | number, b: string | number): number {
  const aNum = typeof a === 'number';
  const bNum = typeof b === 'number';
  if (aNum && bNum) return a < b ? -1 : a > b ? 1 : 0;
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNum) return -1;
  if (bNum) return 1;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function comparePrerelease(a: SemVer, b: SemVer): number {
  // A version without a prerelease outranks one with a prerelease.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i++) {
    const left = a.prerelease[i];
    const right = b.prerelease[i];
    if (left === undefined && right === undefined) return 0;
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const result = compareIdentifiers(left, right);
    if (result !== 0) return result;
  }
  return 0;
}

/** Compares two SemVer objects. Build metadata is ignored, as the spec requires. */
export function compareParsed(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a, b);
}

/** Compares two version strings. Unparseable versions sort last. */
export function compare(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (!left && !right) return a < b ? -1 : a > b ? 1 : 0;
  if (!left) return 1;
  if (!right) return -1;
  return compareParsed(left, right);
}

export function gt(a: string, b: string): boolean {
  return compare(a, b) > 0;
}

export function lt(a: string, b: string): boolean {
  return compare(a, b) < 0;
}

export function eq(a: string, b: string): boolean {
  return compare(a, b) === 0;
}

export type ReleaseType = 'major' | 'minor' | 'patch' | 'prerelease' | 'none';

/**
 * Classifies the change between two versions. Used by `compare_versions` to
 * flag likely breaking changes.
 */
export function diffType(from: string, to: string): ReleaseType | null {
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return null;
  if (compareParsed(a, b) === 0) return 'none';
  if (a.major !== b.major) return 'major';
  if (a.minor !== b.minor) return 'minor';
  if (a.patch !== b.patch) return 'patch';
  return 'prerelease';
}

/**
 * Whether a bump is *likely* breaking under semver.
 *
 * A major bump is breaking; so is any change below 1.0.0, where npm treats the
 * minor position as the breaking one (`^0.2.0` does not match `0.3.0`).
 */
export function isLikelyBreaking(from: string, to: string): boolean {
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return false;
  if (a.major !== b.major) return true;
  if (a.major === 0 && a.minor !== b.minor) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

type Operator = '<' | '<=' | '>' | '>=' | '=';

interface Comparator {
  operator: Operator;
  version: SemVer;
}

/** A parsed range: an OR of comparator sets (each set is an AND). */
export interface Range {
  raw: string;
  sets: Comparator[][];
}

const ANY_MARKER: Comparator[] = [{ operator: '>=', version: parse('0.0.0')! }];

const XRANGE_PART = '(?:0|[1-9]\\d*|[xX*])';
const XRANGE_RE = new RegExp(
  `^(\\^|~>?|>=|<=|>|<|=|v)?\\s*(${XRANGE_PART})(?:\\.(${XRANGE_PART}))?(?:\\.(${XRANGE_PART}))?(?:-([0-9A-Za-z-.]+))?(?:\\+([0-9A-Za-z-.]+))?$`,
);

const HYPHEN_RE = /\s+-\s+/;

function isWildcard(part: string | undefined): boolean {
  return part === undefined || part === '' || part === 'x' || part === 'X' || part === '*';
}

function num(part: string | undefined): number {
  return part === undefined ? 0 : Number(part);
}

function makeVersion(major: number, minor: number, patch: number, pre?: string): SemVer {
  const built = parse(`${major}.${minor}.${patch}${pre ? `-${pre}` : ''}`);
  /* istanbul ignore next -- constructed from validated numbers */
  if (!built) throw new Error(`internal: built an invalid version ${major}.${minor}.${patch}`);
  return built;
}

/**
 * Exclusive upper bounds carry a `-0` prerelease, matching node-semver: `^1.2.3`
 * expands to `>=1.2.3 <2.0.0-0`, so `2.0.0-beta.1` is excluded from a range that
 * was only ever meant to cover 1.x.
 */
function upperBound(major: number, minor: number, patch: number): SemVer {
  return makeVersion(major, minor, patch, '0');
}

/** Expands a single range token (`^1.2`, `>=3`, `1.x`…) into comparators. */
function parseComparator(token: string): Comparator[] | null {
  const trimmed = token.trim();
  if (trimmed === '' || trimmed === '*' || trimmed === 'x' || trimmed === 'X') return ANY_MARKER;

  const match = XRANGE_RE.exec(trimmed);
  if (!match) return null;

  const [, rawOp, rawMajor, rawMinor, rawPatch, pre] = match;
  const op = rawOp === 'v' ? '' : (rawOp ?? '');

  const majorAny = isWildcard(rawMajor);
  const minorAny = isWildcard(rawMinor);
  const patchAny = isWildcard(rawPatch);

  const major = majorAny ? 0 : num(rawMajor);
  const minor = minorAny ? 0 : num(rawMinor);
  const patch = patchAny ? 0 : num(rawPatch);

  if (majorAny) {
    // `*`, `>=*`, `^x` … all mean "any version".
    if (op === '<' || op === '<=') return null;
    return ANY_MARKER;
  }

  switch (op) {
    case '^': {
      const lower = makeVersion(major, minor, patch, pre);
      let upper: SemVer;
      if (major !== 0) upper = upperBound(major + 1, 0, 0);
      else if (minorAny) upper = upperBound(1, 0, 0);
      else if (minor !== 0 || patchAny) upper = upperBound(0, minor + 1, 0);
      else upper = upperBound(0, 0, patch + 1);
      return [
        { operator: '>=', version: lower },
        { operator: '<', version: upper },
      ];
    }
    case '~':
    case '~>': {
      const lower = makeVersion(major, minor, patch, pre);
      const upper = minorAny ? upperBound(major + 1, 0, 0) : upperBound(major, minor + 1, 0);
      return [
        { operator: '>=', version: lower },
        { operator: '<', version: upper },
      ];
    }
    case '>':
      // `>1.2` means "greater than everything in 1.2.x", i.e. `>=1.3.0`.
      if (minorAny) return [{ operator: '>=', version: makeVersion(major + 1, 0, 0) }];
      if (patchAny) return [{ operator: '>=', version: makeVersion(major, minor + 1, 0) }];
      return [{ operator: '>', version: makeVersion(major, minor, patch, pre) }];
    case '>=':
      return [{ operator: '>=', version: makeVersion(major, minor, patch, pre) }];
    case '<':
      if (minorAny) return [{ operator: '<', version: upperBound(major, 0, 0) }];
      if (patchAny) return [{ operator: '<', version: upperBound(major, minor, 0) }];
      return [{ operator: '<', version: makeVersion(major, minor, patch, pre) }];
    case '<=':
      if (minorAny) return [{ operator: '<', version: upperBound(major + 1, 0, 0) }];
      if (patchAny) return [{ operator: '<', version: upperBound(major, minor + 1, 0) }];
      return [{ operator: '<=', version: makeVersion(major, minor, patch, pre) }];
    case '':
    case '=': {
      if (minorAny) {
        return [
          { operator: '>=', version: makeVersion(major, 0, 0) },
          { operator: '<', version: upperBound(major + 1, 0, 0) },
        ];
      }
      if (patchAny) {
        return [
          { operator: '>=', version: makeVersion(major, minor, 0) },
          { operator: '<', version: upperBound(major, minor + 1, 0) },
        ];
      }
      return [{ operator: '=', version: makeVersion(major, minor, patch, pre) }];
    }
    /* istanbul ignore next -- operator alternation is exhaustive */
    default:
      return null;
  }
}

/** Expands `1.2.3 - 2.3.4` into `>=1.2.3 <=2.3.4` (partials widen the bound). */
function parseHyphenRange(left: string, right: string): Comparator[] | null {
  const lowerMatch = XRANGE_RE.exec(left.trim());
  const upperMatch = XRANGE_RE.exec(right.trim());
  if (!lowerMatch || !upperMatch) return null;

  const comparators: Comparator[] = [];

  const [, , loMajor, loMinor, loPatch, loPre] = lowerMatch;
  if (!isWildcard(loMajor)) {
    comparators.push({
      operator: '>=',
      version: makeVersion(num(loMajor), isWildcard(loMinor) ? 0 : num(loMinor), isWildcard(loPatch) ? 0 : num(loPatch), loPre),
    });
  }

  const [, , hiMajor, hiMinor, hiPatch, hiPre] = upperMatch;
  if (!isWildcard(hiMajor)) {
    if (isWildcard(hiMinor)) {
      comparators.push({ operator: '<', version: upperBound(num(hiMajor) + 1, 0, 0) });
    } else if (isWildcard(hiPatch)) {
      comparators.push({ operator: '<', version: upperBound(num(hiMajor), num(hiMinor) + 1, 0) });
    } else {
      comparators.push({
        operator: '<=',
        version: makeVersion(num(hiMajor), num(hiMinor), num(hiPatch), hiPre),
      });
    }
  }

  return comparators.length > 0 ? comparators : ANY_MARKER;
}

/** Parses a full npm range expression. Returns null if it is not a semver range. */
export function parseRange(input: string): Range | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  const sets: Comparator[][] = [];

  for (const alternative of raw.split('||')) {
    const piece = alternative.trim();
    if (piece === '') {
      sets.push(ANY_MARKER);
      continue;
    }

    if (HYPHEN_RE.test(piece)) {
      const [left, right] = piece.split(HYPHEN_RE);
      const hyphen = parseHyphenRange(left ?? '', right ?? '');
      if (!hyphen) return null;
      sets.push(hyphen);
      continue;
    }

    const comparators: Comparator[] = [];
    // Split on whitespace, but keep `>= 1.2.3` (operator detached) together.
    for (const token of piece.split(/\s+/).reduce<string[]>((acc, part) => {
      const last = acc[acc.length - 1];
      if (last !== undefined && /^(\^|~>?|>=|<=|>|<|=)$/.test(last)) acc[acc.length - 1] = last + part;
      else acc.push(part);
      return acc;
    }, [])) {
      const parsed = parseComparator(token);
      if (!parsed) return null;
      if (parsed !== ANY_MARKER) comparators.push(...parsed);
    }

    sets.push(comparators.length > 0 ? comparators : ANY_MARKER);
  }

  return sets.length > 0 ? { raw, sets } : null;
}

function testComparator(version: SemVer, comparator: Comparator): boolean {
  const result = compareParsed(version, comparator.version);
  switch (comparator.operator) {
    case '<':
      return result < 0;
    case '<=':
      return result <= 0;
    case '>':
      return result > 0;
    case '>=':
      return result >= 0;
    case '=':
      return result === 0;
  }
}

export interface SatisfiesOptions {
  /** Allow prereleases to match ranges that do not explicitly mention them. */
  includePrerelease?: boolean;
}

function setAllows(version: SemVer, set: Comparator[], includePrerelease: boolean): boolean {
  for (const comparator of set) {
    if (!testComparator(version, comparator)) return false;
  }

  if (version.prerelease.length === 0 || includePrerelease) return true;

  // node-semver rule: a prerelease only satisfies the set if some comparator
  // in it pins the very same [major, minor, patch] tuple with a prerelease.
  return set.some(
    (comparator) =>
      comparator.version.prerelease.length > 0 &&
      comparator.version.major === version.major &&
      comparator.version.minor === version.minor &&
      comparator.version.patch === version.patch,
  );
}

/** Whether `version` satisfies `range`. Unparseable input is never a match. */
export function satisfies(version: string, range: string, options: SatisfiesOptions = {}): boolean {
  const parsedVersion = parse(version);
  const parsedRange = parseRange(range);
  if (!parsedVersion || !parsedRange) return false;
  const includePrerelease = options.includePrerelease === true;
  return parsedRange.sets.some((set) => setAllows(parsedVersion, set, includePrerelease));
}

/**
 * Highest version in `versions` that satisfies `range`.
 *
 * Stable releases win; if nothing stable matches, prereleases are considered
 * (mirroring how npm resolves a range like `^1.0.0-beta.1`).
 */
export function maxSatisfying(
  versions: readonly string[],
  range: string,
  options: SatisfiesOptions = {},
): string | null {
  let best: SemVer | null = null;

  for (const candidate of versions) {
    const parsed = parse(candidate);
    if (!parsed) continue;
    if (!satisfies(candidate, range, options)) continue;
    if (best === null || compareParsed(parsed, best) > 0) best = parsed;
  }

  if (best !== null) return best.raw;
  if (options.includePrerelease) return null;
  return maxSatisfying(versions, range, { includePrerelease: true });
}

/** Highest stable version in a list; falls back to the highest prerelease. */
export function maxVersion(versions: readonly string[]): string | null {
  let bestStable: SemVer | null = null;
  let bestAny: SemVer | null = null;

  for (const candidate of versions) {
    const parsed = parse(candidate);
    if (!parsed) continue;
    if (bestAny === null || compareParsed(parsed, bestAny) > 0) bestAny = parsed;
    if (parsed.prerelease.length === 0 && (bestStable === null || compareParsed(parsed, bestStable) > 0)) {
      bestStable = parsed;
    }
  }

  return (bestStable ?? bestAny)?.raw ?? null;
}

/** Sorts versions newest-first without mutating the input. */
export function sortDescending(versions: readonly string[]): string[] {
  return [...versions].sort((a, b) => compare(b, a));
}

export type NonRegistrySpecKind = 'alias' | 'git' | 'url' | 'file' | 'workspace' | 'link' | 'tag';

export interface NonRegistrySpec {
  kind: NonRegistrySpecKind;
  /** For `npm:` aliases, the package actually installed. */
  aliasOf?: { name: string; range: string };
}

/**
 * Classifies a dependency specifier that is not a plain semver range, so the
 * dependency tree can report *why* an edge could not be resolved from the
 * registry instead of silently dropping it.
 */
export function classifyNonRegistrySpec(spec: string): NonRegistrySpec | null {
  const value = spec.trim();
  if (value === '') return null;

  if (value.startsWith('npm:')) {
    const rest = value.slice(4);
    const at = rest.lastIndexOf('@');
    // A leading `@` belongs to the scope, not the version separator.
    if (at > 0) {
      return { kind: 'alias', aliasOf: { name: rest.slice(0, at), range: rest.slice(at + 1) } };
    }
    return { kind: 'alias', aliasOf: { name: rest, range: '*' } };
  }
  if (value.startsWith('workspace:')) return { kind: 'workspace' };
  if (value.startsWith('link:')) return { kind: 'link' };
  if (value.startsWith('file:') || value.startsWith('./') || value.startsWith('../')) return { kind: 'file' };
  if (/^(git|git\+ssh|git\+https?|ssh):/.test(value) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(value)) {
    return { kind: 'git' };
  }
  if (/^https?:/.test(value)) return { kind: 'url' };
  if (parseRange(value) === null) return { kind: 'tag' };
  return null;
}
