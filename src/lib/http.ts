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
  /** Overrides for the retry schedule; merged over `DEFAULT_RETRY`. */
  retry?: Partial<RetryPolicy>;
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

export interface RetryPolicy {
  /** Total attempts, including the first. `1` disables retrying. */
  attempts: number;
  /** Delay before the first retry; doubles on each subsequent one. */
  baseDelayMs: number;
  /** Ceiling on any single sleep, including a server-supplied `Retry-After`. */
  maxDelayMs: number;
  /** Ceiling on time spent sleeping across all retries for one request. */
  maxTotalDelayMs: number;
}

/** Conservative default: one quick retry, never blocking a tool call for long. */
export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 2,
  baseDelayMs: 500,
  maxDelayMs: 2_000,
  maxTotalDelayMs: 2_000,
};

/**
 * bundlephobia builds packages on demand and rate-limits aggressively, so a
 * single 500ms retry is frequently not enough. It gets more attempts and a
 * longer backoff; it is an optional data source fetched in parallel with the
 * rest, so the extra wait does not delay anything else.
 */
export const PATIENT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 800,
  maxDelayMs: 2_500,
  maxTotalDelayMs: 4_000,
};

/**
 * Detects a bot-protection challenge masquerading as a rate limit.
 *
 * Services behind Vercel's or Cloudflare's bot mitigation answer with HTTP 429
 * plus an HTML challenge page. That status is indistinguishable from throttling
 * by code alone, but the two need opposite handling: a throttle clears if you
 * wait, a challenge never does. Retrying one wastes seconds per call and keeps
 * hammering a host that already said no.
 *
 * We do not attempt to solve challenges. We detect them, stop, and say so.
 */
export function isBotChallenge(status: number, headers: Headers): boolean {
  if (status !== 429 && status !== 403 && status !== 503) return false;

  // Explicit mitigation markers are conclusive.
  for (const header of ['x-vercel-mitigated', 'cf-mitigated']) {
    const value = headers.get(header);
    if (value && value.toLowerCase().includes('challenge')) return true;
  }
  if (headers.get('x-vercel-challenge-token') || headers.get('cf-chl-bypass')) return true;

  // We asked for JSON and got an HTML page: an interstitial, not an API reply.
  // Retrying a JSON request that yields HTML is not going to start working.
  return (headers.get('content-type') ?? '').includes('text/html');
}

/**
 * Exponential backoff with jitter, honouring `Retry-After` when the server
 * sends one. `attempt` is 1-based (the delay *after* attempt 1 uses `attempt: 1`).
 *
 * Pure, with jitter injected, so the schedule can be unit tested.
 */
export function computeBackoffMs(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | null = null,
  jitter: number = Math.random(),
): number {
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  // A server's own Retry-After wins over our guess, but is still capped.
  const base = retryAfterMs !== null && retryAfterMs >= 0 ? retryAfterMs : exponential;
  const capped = Math.min(base, policy.maxDelayMs);
  // Up to +25% spread so parallel callers do not retry in lockstep.
  return Math.round(capped * (1 + Math.min(Math.max(jitter, 0), 1) * 0.25));
}

/**
 * Performs a JSON request against an allow-listed host.
 *
 * Retries 429/5xx responses on an exponential backoff bounded by the retry
 * policy. Once the attempts or the total delay budget are exhausted, the
 * failure is surfaced as a RATE_LIMITED / UPSTREAM_ERROR result rather than
 * blocking the tool call any further.
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

  const retry: RetryPolicy = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };

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

  const maxAttempts = Math.max(1, retry.attempts);
  let lastRateLimited: HttpError | null = null;
  let spentDelayMs = 0;

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

    // A challenge is deterministic, so retrying it only wastes the caller's
    // time. Fail immediately with a message that does not promise a retry.
    if (isBotChallenge(res.status, res.headers)) {
      throw new HttpError(
        'BLOCKED',
        res.status,
        rawUrl,
        `${source} served a bot-protection challenge (HTTP ${res.status}) instead of data, so it cannot be queried programmatically. This is not transient — waiting and retrying will not help.`,
      );
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
      if (attempt < maxAttempts) {
        const delay = computeBackoffMs(attempt, retry, wait);
        // Stop early rather than exceed the caller's total waiting budget.
        if (spentDelayMs + delay <= retry.maxTotalDelayMs) {
          spentDelayMs += delay;
          await sleep(delay);
          continue;
        }
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
