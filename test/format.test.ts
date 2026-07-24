import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  daysBetween,
  downloadSeconds,
  humanBytes,
  humanCount,
  humanSeconds,
  isoDate,
  lines,
  listPhrase,
  momentumFrom,
  normalizeRepositoryUrl,
  percentChange,
  plural,
  relativeTime,
  truncate,
} from '../src/lib/format.js';

describe('humanBytes', () => {
  it('formats each unit', () => {
    assert.equal(humanBytes(0), '0 B');
    assert.equal(humanBytes(512), '512 B');
    assert.equal(humanBytes(1024), '1.0 KB');
    assert.equal(humanBytes(1536), '1.5 KB');
    assert.equal(humanBytes(1024 * 1024), '1.0 MB');
    assert.equal(humanBytes(1024 * 1024 * 1024), '1.0 GB');
  });

  it('drops the decimal above 10 units', () => {
    assert.equal(humanBytes(1024 * 15), '15 KB');
    assert.equal(humanBytes(1024 * 9.5), '9.5 KB');
  });

  it('reports unknown for missing or nonsense values', () => {
    assert.equal(humanBytes(null), 'unknown');
    assert.equal(humanBytes(undefined), 'unknown');
    assert.equal(humanBytes(Number.NaN), 'unknown');
    assert.equal(humanBytes(-5), 'unknown');
  });
});

describe('humanCount', () => {
  it('adds thousands separators', () => {
    assert.equal(humanCount(1234567), '1,234,567');
    assert.equal(humanCount(0), '0');
    assert.equal(humanCount(null), 'unknown');
  });
});

describe('daysBetween / isoDate', () => {
  it('counts whole days forwards and backwards', () => {
    assert.equal(daysBetween('2024-01-01T00:00:00Z', '2024-01-11T00:00:00Z'), 10);
    assert.equal(daysBetween('2024-01-11T00:00:00Z', '2024-01-01T00:00:00Z'), -10);
  });

  it('returns null for invalid dates', () => {
    assert.equal(daysBetween('nope', '2024-01-01T00:00:00Z'), null);
    assert.equal(isoDate('nope'), null);
  });

  it('extracts the ISO date part', () => {
    assert.equal(isoDate('2024-03-05T12:34:56.000Z'), '2024-03-05');
  });
});

describe('relativeTime', () => {
  const now = new Date('2024-06-15T12:00:00Z');

  it('describes past instants', () => {
    assert.equal(relativeTime('2024-06-15T11:00:00Z', now), '1 hour ago');
    assert.equal(relativeTime('2024-06-12T12:00:00Z', now), '3 days ago');
    assert.equal(relativeTime('2024-03-15T12:00:00Z', now), '3 months ago');
    assert.equal(relativeTime('2022-06-15T12:00:00Z', now), '2 years ago');
  });

  it('describes future instants', () => {
    assert.equal(relativeTime('2024-06-18T12:00:00Z', now), 'in 3 days');
  });

  it('handles missing input', () => {
    assert.equal(relativeTime(null, now), 'unknown');
  });
});

describe('plural', () => {
  it('pluralises only when needed', () => {
    assert.equal(plural(1, 'day'), '1 day');
    assert.equal(plural(2, 'day'), '2 days');
    assert.equal(plural(0, 'day'), '0 days');
    assert.equal(plural(1.55, 'year'), '1.6 years');
  });
});

describe('percentChange and momentum', () => {
  it('computes signed percentage change', () => {
    assert.equal(percentChange(100, 150), 50);
    assert.equal(percentChange(100, 50), -50);
    assert.equal(percentChange(100, 100), 0);
  });

  it('handles a zero baseline', () => {
    assert.equal(percentChange(0, 0), 0);
    assert.equal(percentChange(0, 10), null);
  });

  it('buckets change into momentum, with a stable band', () => {
    assert.equal(momentumFrom(25), 'growing');
    assert.equal(momentumFrom(-25), 'declining');
    assert.equal(momentumFrom(5), 'stable');
    assert.equal(momentumFrom(-9.9), 'stable');
    assert.equal(momentumFrom(null), 'unknown');
  });
});

describe('downloadSeconds / humanSeconds', () => {
  it('converts bytes to transfer seconds', () => {
    // 50 kbps = 6250 bytes/sec, so 6250 bytes should take ~1 second.
    assert.equal(downloadSeconds(6250, 50), 1);
    assert.equal(downloadSeconds(0, 50), 0);
  });

  it('formats durations readably', () => {
    assert.equal(humanSeconds(0.34), '340 ms');
    assert.equal(humanSeconds(1.234), '1.23 s');
    assert.equal(humanSeconds(42.5), '42.5 s');
    assert.equal(humanSeconds(90), '1m 30s');
  });
});

describe('truncate', () => {
  it('collapses whitespace and leaves short text alone', () => {
    assert.equal(truncate('  hello   world '), 'hello world');
    assert.equal(truncate(null), null);
  });

  it('appends an ellipsis past the limit', () => {
    const result = truncate('a'.repeat(50), 10);
    assert.equal(result?.length, 10);
    assert.ok(result?.endsWith('…'));
  });
});

describe('normalizeRepositoryUrl', () => {
  it('normalises the many shapes npm allows', () => {
    assert.equal(normalizeRepositoryUrl('git+https://github.com/a/b.git'), 'https://github.com/a/b');
    assert.equal(normalizeRepositoryUrl({ url: 'git://github.com/a/b.git' }), 'https://github.com/a/b');
    assert.equal(normalizeRepositoryUrl('git@github.com:a/b.git'), 'https://github.com/a/b');
    assert.equal(normalizeRepositoryUrl('ssh://git@github.com/a/b.git'), 'https://github.com/a/b');
    assert.equal(normalizeRepositoryUrl('a/b'), 'https://github.com/a/b');
    assert.equal(normalizeRepositoryUrl('https://gitlab.com/a/b'), 'https://gitlab.com/a/b');
  });

  it('returns null for missing or unusable values', () => {
    assert.equal(normalizeRepositoryUrl(null), null);
    assert.equal(normalizeRepositoryUrl(''), null);
    assert.equal(normalizeRepositoryUrl({}), null);
    assert.equal(normalizeRepositoryUrl('not a url at all'), null);
  });
});

describe('lines and listPhrase', () => {
  it('drops empty and falsy segments', () => {
    assert.equal(lines('a', null, undefined, false, '', 'b'), 'a\nb');
  });

  it('builds a natural list phrase', () => {
    assert.equal(listPhrase([]), '');
    assert.equal(listPhrase(['a']), 'a');
    assert.equal(listPhrase(['a', 'b']), 'a and b');
    assert.equal(listPhrase(['a', 'b', 'c']), 'a, b and c');
  });
});
