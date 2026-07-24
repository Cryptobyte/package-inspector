/**
 * A small, deliberately conservative list of extremely popular npm packages —
 * the ones most worth impersonating. Kept in-repo so the check needs no
 * network call and is fully auditable.
 */
export const POPULAR_PACKAGES: readonly string[] = Object.freeze([
  'react',
  'react-dom',
  'react-router',
  'lodash',
  'underscore',
  'express',
  'axios',
  'chalk',
  'commander',
  'debug',
  'next',
  'vue',
  'angular',
  'svelte',
  'typescript',
  'webpack',
  'vite',
  'rollup',
  'esbuild',
  'babel',
  'eslint',
  'prettier',
  'jest',
  'mocha',
  'chai',
  'vitest',
  'moment',
  'dayjs',
  'date-fns',
  'uuid',
  'yargs',
  'dotenv',
  'request',
  'node-fetch',
  'cross-env',
  'rimraf',
  'glob',
  'minimist',
  'semver',
  'socket.io',
  'mongoose',
  'sequelize',
  'prisma',
  'graphql',
  'apollo-client',
  'redux',
  'zustand',
  'jquery',
  'bootstrap',
  'tailwindcss',
  'postcss',
  'sass',
  'three',
  'd3',
  'zod',
  'ramda',
  'rxjs',
  'ws',
  'cors',
  'body-parser',
  'nodemon',
  'pm2',
  'winston',
  'pino',
  'ora',
  'inquirer',
  'colors',
  'left-pad',
  'is-odd',
  'classnames',
  'immer',
  'formik',
  'stripe',
  'firebase',
  'openai',
]);

/**
 * Levenshtein edit distance, with an optional early-exit ceiling.
 *
 * Uses a single rolling row: O(min(a,b)) memory.
 */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  // Keep the shorter string as the row so memory stays minimal.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];

  let previous: number[] = Array.from({ length: short.length + 1 }, (_, i) => i);
  const current: number[] = new Array<number>(short.length + 1);

  for (let i = 1; i <= long.length; i++) {
    current[0] = i;
    let rowMin = i;

    for (let j = 1; j <= short.length; j++) {
      const cost = long[i - 1] === short[j - 1] ? 0 : 1;
      const value = Math.min(
        (current[j - 1] ?? 0) + 1, // insertion
        (previous[j] ?? 0) + 1, // deletion
        (previous[j - 1] ?? 0) + cost, // substitution
      );
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }

    if (rowMin > max) return max + 1;
    previous = [...current];
  }

  return previous[short.length] ?? 0;
}

/** Strips the scope from `@scope/name`; leaves unscoped names untouched. */
export function unscopedName(name: string): string {
  const slash = name.indexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
}

export type TyposquatTechnique =
  | 'edit-distance'
  | 'separator-swap'
  | 'digit-substitution'
  | 'repeated-character'
  | 'scope-impersonation';

export interface TyposquatMatch {
  /** The popular package this name resembles. */
  target: string;
  distance: number;
  technique: TyposquatTechnique;
}

/** Canonical form used to catch `lo-dash` / `lo.dash` / `lodash` collisions. */
function stripSeparators(value: string): string {
  return value.replace(/[-._]/g, '');
}

const DIGIT_LOOKALIKES: Record<string, string> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
};

/** Maps digits back to the letters they imitate, e.g. `rea1ct` -> `realct`. */
function normalizeLookalikes(value: string): string {
  return value.replace(/[013457]/g, (digit) => DIGIT_LOOKALIKES[digit] ?? digit);
}

/** Collapses runs of a repeated character, catching `expresss` / `axioss`. */
function collapseRepeats(value: string): string {
  return value.replace(/(.)\1+/g, '$1');
}

/**
 * Finds popular packages that `name` closely resembles.
 *
 * An exact match returns nothing — the package *is* the popular one.
 * Results are sorted by increasing distance (closest impersonation first).
 */
export function findTyposquatMatches(
  name: string,
  popular: readonly string[] = POPULAR_PACKAGES,
  maxDistance = 2,
): TyposquatMatch[] {
  const lower = name.toLowerCase();
  const bare = unscopedName(lower);
  const matches: TyposquatMatch[] = [];

  for (const target of popular) {
    if (lower === target || bare === target) continue;

    // A scoped package impersonating an unscoped popular one, e.g. @react/core.
    if (lower.startsWith('@') && lower.slice(1).split('/')[0] === target) {
      matches.push({ target, distance: 0, technique: 'scope-impersonation' });
      continue;
    }

    if (stripSeparators(bare) === stripSeparators(target)) {
      matches.push({ target, distance: 1, technique: 'separator-swap' });
      continue;
    }

    if (bare !== target && normalizeLookalikes(bare) === normalizeLookalikes(target)) {
      matches.push({ target, distance: 1, technique: 'digit-substitution' });
      continue;
    }

    if (bare !== target && collapseRepeats(bare) === collapseRepeats(target)) {
      matches.push({ target, distance: 1, technique: 'repeated-character' });
      continue;
    }

    // Short names generate too many false positives at distance 2.
    const ceiling = target.length <= 4 ? 1 : maxDistance;
    const distance = levenshtein(bare, target, ceiling);
    if (distance <= ceiling) {
      matches.push({ target, distance, technique: 'edit-distance' });
    }
  }

  return matches.sort((a, b) => a.distance - b.distance || a.target.localeCompare(b.target));
}
