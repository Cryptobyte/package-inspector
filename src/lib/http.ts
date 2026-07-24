/**
 * The single network boundary of this server.
 *
 * Everything that leaves the process goes through `fetchJson`, and `fetchJson`
 * refuses any host that is not in `ALLOWED_HOSTS`. Auditors only need to read
 * this file to know the complete outbound surface.
 *
 * No credentials, cookies, or authentication of any kind are ever sent, and no
 * data about the user or their machine is transmitted — only the package name
 * and version being inspected.
 */

import { HttpError, ToolError } from './errors.js';
import { USER_AGENT } from './version.js';

/** The complete set of hosts this server is permitted to contact. */
export const ALLOWED_HOSTS: readonly string[] = Object.freeze([
  'registry.npmjs.org', // package metadata + search
  'api.npmjs.org', // download counts
  'api.osv.dev', // vulnerability advisories
  'packagephobia.com', // install / publish size
  'bundlephobia.com', // minified + gzipped bundle size
]);

export const DEFAULT_TIMEOUT_MS = 10_000;
/** Registry responses are cached for 5 minutes to avoid hammering upstreams. */
export const DEFAULT_TTL_MS = 5 * 60_000;
/** Hard ceiling on a single response body; full packuments can be very large. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Upper bound on cache entries, so a long-lived server cannot grow forever. */
const MAX_CACHE_ENTRIES = 500;

export interface FetchJsonOptions {
  method?: 'GET' | 'POST';
  /** JSON request body; sets `content-type: application/json`. */
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Treat a 404 as `null` rather than throwing. */
  notFoundAsNull?: boolean;
  /** Human-readable upstream name used in error messages. */
  source?: string;
}

function assertAllowedHost(url: URL): void {
  if (url.protocol !== 'https:') {
    throw new ToolError('INTERNAL', `Refusing non-https request to ${url.protocol}//${url.host}`);
  }
  if (!ALLOWED_HOSTS.includes(url.hostname)) {
    throw new ToolError(
      'INTERNAL',
      `Refusing request to disallowed host "${url.hostname}". Allowed hosts: ${ALLOWED_HOSTS.join(', ')}`,
    );
  }
}

/** Reads a response body with a hard size cap, aborting the stream if exceeded. */
async function readBodyCapped(res: Response, url: string): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new HttpError(
      'TOO_LARGE',
      res.status,
      url,
      `Response is ${declared} bytes, which exceeds the ${MAX_RESPONSE_BYTES} byte limit.`,
    );
  }

  if (!res.body) return '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new HttpError(
          'TOO_LARGE',
          res.status,
          url,
          `Response exceeded the ${MAX_RESPONSE_BYTES} byte limit and was aborted.`,
        );
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }

  chunks.push(decoder.decode());
  return chunks.join('');
}

function retryAfterMs(res: Response): number | null {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Performs a JSON request against an allow-listed host.
 *
 * Retries once on 429/5xx (honouring a short `Retry-After`); anything longer is
 * surfaced as a RATE_LIMITED error rather than blocking the tool call.
 */
export async function fetchJson<T>(rawUrl: string, options: FetchJsonOptions = {}): Promise<T | null> {
  const url = new URL(rawUrl);
  assertAllowedHost(url);

  const {
    method = 'GET',
    body,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    notFoundAsNull = false,
    source = url.hostname,
  } = options;

  const requestHeaders: Record<string, string> = {
    accept: 'application/json',
    'user-agent': USER_AGENT,
    ...headers,
  };

  const init: RequestInit = { method, headers: requestHeaders, redirect: 'follow' };
  if (body !== undefined) {
    requestHeaders['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const maxAttempts = 2;
  let lastRateLimited: HttpError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new ToolError('TIMEOUT', `${source} did not respond within ${timeoutMs}ms.`);
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new ToolError('UPSTREAM_UNAVAILABLE', `Could not reach ${source}: ${detail}`);
    }

    if (res.status === 404 || res.status === 405) {
      if (notFoundAsNull) return null;
      throw new HttpError('NOT_FOUND', res.status, rawUrl, `${source} returned 404 Not Found.`);
    }

    if (res.status === 429 || res.status >= 500) {
      const wait = retryAfterMs(res);
      const code = res.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_ERROR';
      lastRateLimited = new HttpError(
        code,
        res.status,
        rawUrl,
        res.status === 429
          ? `${source} is rate limiting requests (HTTP 429). Try again in a moment.`
          : `${source} returned HTTP ${res.status}.`,
      );
      // Only retry when the upstream asks us to wait a short, polite amount.
      if (attempt < maxAttempts) {
        await sleep(Math.min(wait ?? 500, 2_000));
        continue;
      }
      throw lastRateLimited;
    }

    if (!res.ok) {
      throw new HttpError('UPSTREAM_ERROR', res.status, rawUrl, `${source} returned HTTP ${res.status}.`);
    }

    const text = await readBodyCapped(res, rawUrl);
    if (text.trim() === '') return null;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ToolError('UPSTREAM_ERROR', `${source} returned a response that is not valid JSON.`);
    }
  }

  /* istanbul ignore next -- loop always returns or throws */
  throw lastRateLimited ?? new ToolError('UPSTREAM_ERROR', `${source} request failed.`);
}

// ---------------------------------------------------------------------------
// TTL cache
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const cache = new Map<string, CacheEntry<unknown>>();
/** De-duplicates concurrent requests for the same key (common in tree walks). */
const inflight = new Map<string, Promise<unknown>>();

function pruneCache(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  // Still oversized? Drop oldest insertions (Map preserves insertion order).
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * Memoizes `producer` under `key` for `ttlMs`, collapsing concurrent callers
 * onto a single in-flight promise.
 */
export async function cached<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = producer()
    .then((value) => {
      cache.set(key, { expiresAt: Date.now() + ttlMs, value });
      pruneCache();
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, promise);
  return promise;
}

export function clearCache(): void {
  cache.clear();
  inflight.clear();
}

export function cacheStats(): { entries: number; inflight: number } {
  return { entries: cache.size, inflight: inflight.size };
}
