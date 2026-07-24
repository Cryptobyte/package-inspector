import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { highestRating, normalizeRating, ratingFor, ratingRank, roundUp1, scoreCvss } from '../src/lib/cvss.js';
import { summarizeAdvisories } from '../src/lib/osv.js';
import type { Advisory } from '../src/lib/osv.js';

describe('roundUp1', () => {
  it('rounds up to one decimal place', () => {
    assert.equal(roundUp1(4.02), 4.1);
    assert.equal(roundUp1(4.0), 4.0);
    assert.equal(roundUp1(9.95), 10);
  });

  it('does not inflate values already at one decimal', () => {
    assert.equal(roundUp1(7.5), 7.5);
  });
});

describe('scoreCvss', () => {
  it('scores a known critical vector', () => {
    // CVE-2021-44228 (Log4Shell): AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H = 10.0
    const result = scoreCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H');
    assert.equal(result?.score, 10);
    assert.equal(result?.rating, 'critical');
  });

  it('scores a known high vector', () => {
    // AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N = 7.5
    const result = scoreCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N');
    assert.equal(result?.score, 7.5);
    assert.equal(result?.rating, 'high');
  });

  it('scores a known medium vector', () => {
    // AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:N = 4.3
    const result = scoreCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:N');
    assert.equal(result?.score, 4.3);
    assert.equal(result?.rating, 'medium');
  });

  it('scores a scope-changed vector, which uses a different formula', () => {
    // AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N = 5.4
    const result = scoreCvss('CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N');
    assert.equal(result?.score, 5.4);
  });

  it('returns zero when there is no impact', () => {
    const result = scoreCvss('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N');
    assert.equal(result?.score, 0);
    assert.equal(result?.rating, 'none');
  });

  it('also handles 3.0 vectors', () => {
    assert.equal(scoreCvss('CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N')?.score, 7.5);
  });

  it('recognises but does not score v4.0 vectors', () => {
    const result = scoreCvss('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N');
    assert.equal(result?.version, '4.0');
    assert.equal(result?.score, null);
  });

  it('returns null for non-CVSS strings', () => {
    assert.equal(scoreCvss('HIGH'), null);
    assert.equal(scoreCvss(''), null);
  });

  it('returns a null score for a malformed v3 vector rather than throwing', () => {
    const result = scoreCvss('CVSS:3.1/AV:Z/AC:L');
    assert.equal(result?.score, null);
  });
});

describe('ratingFor', () => {
  it('applies the standard qualitative bands', () => {
    assert.equal(ratingFor(0), 'none');
    assert.equal(ratingFor(3.9), 'low');
    assert.equal(ratingFor(4.0), 'medium');
    assert.equal(ratingFor(6.9), 'medium');
    assert.equal(ratingFor(7.0), 'high');
    assert.equal(ratingFor(8.9), 'high');
    assert.equal(ratingFor(9.0), 'critical');
    assert.equal(ratingFor(10), 'critical');
  });
});

describe('normalizeRating', () => {
  it("maps GitHub's MODERATE onto medium", () => {
    assert.equal(normalizeRating('MODERATE'), 'medium');
    assert.equal(normalizeRating('moderate'), 'medium');
  });

  it('passes through the standard words', () => {
    assert.equal(normalizeRating('CRITICAL'), 'critical');
    assert.equal(normalizeRating('High'), 'high');
    assert.equal(normalizeRating('low'), 'low');
  });

  it('returns null for unknown or missing values', () => {
    assert.equal(normalizeRating('UNKNOWN'), null);
    assert.equal(normalizeRating(null), null);
    assert.equal(normalizeRating('banana'), null);
  });
});

describe('highestRating and ratingRank', () => {
  it('picks the most severe rating', () => {
    assert.equal(highestRating(['low', 'critical', 'medium']), 'critical');
    assert.equal(highestRating(['low', null]), 'low');
    assert.equal(highestRating([null, null]), null);
    assert.equal(highestRating([]), null);
  });

  it('ranks severities in order', () => {
    assert.ok(ratingRank('critical') > ratingRank('high'));
    assert.ok(ratingRank('high') > ratingRank('medium'));
    assert.equal(ratingRank(null), -1);
  });
});

describe('summarizeAdvisories', () => {
  const advisory = (id: string, severity: Advisory['severity'], fixedVersions: string[] = []): Advisory =>
    ({
      id,
      aliases: [],
      cve: null,
      summary: null,
      details: null,
      severity,
      cvssScore: null,
      cvssVector: null,
      cwes: [],
      published: null,
      modified: null,
      affectedRanges: [],
      fixedVersions,
      references: [],
    }) satisfies Advisory;

  it('reports a clean set', () => {
    const report = summarizeAdvisories([]);
    assert.equal(report.advisories.length, 0);
    assert.equal(report.highestSeverity, null);
    assert.deepEqual(report.suggestedFixVersions, []);
  });

  it('counts by severity and sorts most severe first', () => {
    const report = summarizeAdvisories([advisory('A', 'low'), advisory('B', 'critical'), advisory('C', 'medium')]);
    assert.equal(report.advisories[0]?.id, 'B');
    assert.equal(report.highestSeverity, 'critical');
    assert.equal(report.counts.critical, 1);
    assert.equal(report.counts.low, 1);
  });

  it('counts advisories with no severity as unknown', () => {
    assert.equal(summarizeAdvisories([advisory('A', null)]).counts.unknown, 1);
  });

  it('suggests only versions that fix every advisory', () => {
    const report = summarizeAdvisories([advisory('A', 'high', ['1.2.0', '2.0.0']), advisory('B', 'high', ['2.0.0'])]);
    assert.deepEqual(report.suggestedFixVersions, ['2.0.0']);
  });

  it('suggests nothing when one advisory is unfixed', () => {
    const report = summarizeAdvisories([advisory('A', 'high', ['1.2.0']), advisory('B', 'high', [])]);
    assert.deepEqual(report.suggestedFixVersions, []);
  });
});
