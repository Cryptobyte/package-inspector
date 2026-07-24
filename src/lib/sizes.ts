/**
 * Bundle size client: bundlephobia, for what shipping a package to a browser
 * costs.
 *
 * A free community service with no auth. It builds packages on demand and
 * frequently returns 429/503 for cold entries, so callers treat a failure here
 * as a missing section, never a failed tool call.
 *
 * On-disk install size is *not* fetched from a third party — see
 * `install-size.ts`, which derives it from npm registry metadata.
 */

import { cached, DEFAULT_TTL_MS, fetchJson, PATIENT_RETRY } from './http.js';
import { DegradedError } from './errors.js';
import { downloadSeconds } from './format.js';

const BUNDLEPHOBIA = 'https://bundlephobia.com/api/size';

/** Bundlephobia's own reference connection speeds. */
export const SLOW_3G_KBPS = 50;
export const EMERGING_4G_KBPS = 875;

export interface BundleSize {
  version: string | null;
  /** Minified bytes. */
  size: number | null;
  /** Minified + gzipped bytes — the number that actually matters. */
  gzip: number | null;
  dependencyCount: number | null;
  hasJSModule: boolean;
  hasSideEffects: boolean | null;
  /** True when the package declares `sideEffects: false` (safe to tree-shake). */
  treeShakeable: boolean | null;
  isModuleType: boolean;
  /** The heaviest direct dependencies, when bundlephobia reports them. */
  heaviestDependencies: Array<{ name: string; approximateSize: number }>;
  downloadTime: {
    slow3gSeconds: number;
    emerging4gSeconds: number;
  } | null;
}

interface BundlephobiaResponse {
  name?: string;
  version?: string;
  size?: number;
  gzip?: number;
  dependencyCount?: number;
  hasJSModule?: boolean | string;
  hasSideEffects?: boolean | string[];
  isModuleType?: boolean;
  dependencySizes?: Array<{ name?: string; approximateSize?: number }>;
  error?: { code?: string; message?: string };
}

export async function getBundleSize(name: string, version: string): Promise<BundleSize> {
  const spec = `${name}@${version}`;

  return cached(`bundlephobia:${spec}`, DEFAULT_TTL_MS, async () => {
    const url = new URL(BUNDLEPHOBIA);
    url.searchParams.set('package', spec);

    const raw = await fetchJson<BundlephobiaResponse>(url.toString(), {
      source: 'bundlephobia',
      notFoundAsNull: true,
      // Bundlephobia builds packages on demand; cold entries are slow.
      timeoutMs: 15_000,
      headers: { 'x-bundlephobia-user': 'package-inspector' },
      retry: PATIENT_RETRY,
    });

    if (!raw || raw.error) {
      const detail = raw?.error?.message ?? 'no bundle data available';
      throw new DegradedError('bundlephobia', `bundlephobia could not size ${spec}: ${detail}`);
    }

    const gzip = typeof raw.gzip === 'number' ? raw.gzip : null;
    // `hasSideEffects` is `true`, `false`, or an array of glob patterns.
    const sideEffects = Array.isArray(raw.hasSideEffects) ? true : (raw.hasSideEffects ?? null);

    return {
      version: raw.version ?? null,
      size: typeof raw.size === 'number' ? raw.size : null,
      gzip,
      dependencyCount: typeof raw.dependencyCount === 'number' ? raw.dependencyCount : null,
      hasJSModule: Boolean(raw.hasJSModule),
      hasSideEffects: typeof sideEffects === 'boolean' ? sideEffects : null,
      treeShakeable: typeof sideEffects === 'boolean' ? !sideEffects : null,
      isModuleType: Boolean(raw.isModuleType),
      heaviestDependencies: (raw.dependencySizes ?? [])
        .filter(
          (entry): entry is { name: string; approximateSize: number } =>
            typeof entry?.name === 'string' && typeof entry?.approximateSize === 'number',
        )
        // Bundlephobia includes the package's own code in this list; that is
        // reported as the bundle size, not as one of its dependencies.
        .filter((entry) => entry.name !== name)
        .sort((a, b) => b.approximateSize - a.approximateSize)
        .slice(0, 5),
      downloadTime:
        gzip === null
          ? null
          : {
              slow3gSeconds: downloadSeconds(gzip, SLOW_3G_KBPS),
              emerging4gSeconds: downloadSeconds(gzip, EMERGING_4G_KBPS),
            },
    } satisfies BundleSize;
  });
}
