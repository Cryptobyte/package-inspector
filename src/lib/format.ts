/**
 * Pure presentation helpers: byte sizes, dates, counts, and the small pieces of
 * prose the tools assemble into their summary lines.
 *
 * Everything here is deterministic and side-effect free (dates take an explicit
 * `now` so they can be unit tested).
 */

const KB = 1024;
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Formats a byte count as a compact human string, e.g. `1.4 MB`. */
export function humanBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return 'unknown';
  if (bytes < 0) return 'unknown';
  if (bytes < KB) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unit = 0;
  while (value >= KB && unit < UNITS.length - 1) {
    value /= KB;
    unit++;
  }
  // One decimal below 10, none above — reads better at a glance.
  const digits = value < 10 ? 1 : 0;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Formats a count with thousands separators, e.g. `1,234,567`. */
export function humanCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unknown';
  return Math.round(value).toLocaleString('en-US');
}

export const MS_PER_DAY = 86_400_000;

/** Whole days between two instants (positive when `to` is later). */
export function daysBetween(from: Date | string | number, to: Date | string | number): number | null {
  const a = toDate(from);
  const b = toDate(to);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

function toDate(value: Date | string | number | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `2024-03-01` — the date portion of an ISO timestamp, in UTC. */
export function isoDate(value: Date | string | number | null | undefined): string | null {
  const date = toDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

/**
 * Human relative time, e.g. `3 months ago` / `in 2 days`.
 * `now` is injected so this is testable without freezing the clock.
 */
export function relativeTime(value: Date | string | number | null | undefined, now: Date = new Date()): string {
  const date = toDate(value);
  if (!date) return 'unknown';

  const deltaMs = date.getTime() - now.getTime();
  const past = deltaMs < 0;
  const abs = Math.abs(deltaMs);

  const days = abs / MS_PER_DAY;
  let phrase: string;

  if (abs < 60_000) phrase = 'less than a minute';
  else if (abs < 3_600_000) phrase = plural(Math.round(abs / 60_000), 'minute');
  else if (days < 1) phrase = plural(Math.round(abs / 3_600_000), 'hour');
  else if (days < 30) phrase = plural(Math.round(days), 'day');
  else if (days < 365) phrase = plural(Math.round(days / 30.44), 'month');
  else phrase = plural(Math.round((days / 365.25) * 10) / 10, 'year');

  return past ? `${phrase} ago` : `in ${phrase}`;
}

export function plural(value: number, noun: string): string {
  const rounded = Number.isInteger(value) ? value : Number(value.toFixed(1));
  return `${rounded} ${noun}${rounded === 1 ? '' : 's'}`;
}

/** Percentage change from `previous` to `current`, or null if undefined. */
export function percentChange(previous: number, current: number): number | null {
  if (!Number.isFinite(previous) || !Number.isFinite(current)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

export type Momentum = 'growing' | 'stable' | 'declining' | 'unknown';

/** Classifies a percentage change into a momentum bucket (±10% = stable). */
export function momentumFrom(change: number | null, threshold = 10): Momentum {
  if (change === null) return 'unknown';
  if (change > threshold) return 'growing';
  if (change < -threshold) return 'declining';
  return 'stable';
}

export function formatPercent(change: number | null): string {
  if (change === null) return 'n/a';
  const sign = change > 0 ? '+' : '';
  return `${sign}${change}%`;
}

/** Estimated seconds to download `bytes` on a link of `kbps` kilobits/sec. */
export function downloadSeconds(bytes: number, kbps: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0 || kbps <= 0) return 0;
  return Number(((bytes * 8) / (kbps * 1000)).toFixed(2));
}

/** `1.2 s` / `340 ms` — for bundle download-time estimates. */
export function humanSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${Number(seconds.toFixed(seconds < 10 ? 2 : 1))} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

/** Truncates long free text (advisory details, descriptions) for summaries. */
export function truncate(text: string | null | undefined, max = 200): string | null {
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

/** Normalises the many shapes an npm `repository` field can take into a URL. */
export function normalizeRepositoryUrl(repository: unknown): string | null {
  const raw =
    typeof repository === 'string'
      ? repository
      : typeof repository === 'object' && repository !== null && 'url' in repository
        ? (repository as { url?: unknown }).url
        : null;

  if (typeof raw !== 'string' || raw.trim() === '') return null;

  let url = raw.trim();
  url = url.replace(/^git\+/, '').replace(/\.git$/, '');
  if (url.startsWith('git://')) url = `https://${url.slice(6)}`;
  if (url.startsWith('git@github.com:')) url = `https://github.com/${url.slice(15)}`;
  if (url.startsWith('ssh://git@')) url = `https://${url.slice(10)}`;
  // Bare `owner/repo` shorthand is GitHub by convention.
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  if (!/^https?:\/\//.test(url)) return null;

  return url;
}

/** Joins non-empty lines; used to build the human summary block. */
export function lines(...parts: Array<string | null | undefined | false>): string {
  return parts.filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
}

/** `a, b and c` */
export function listPhrase(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
