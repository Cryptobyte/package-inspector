/**
 * Tests that need no network: input validation, the host allowlist, the cache,
 * and the shape of the tool registry itself.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { TOOLS, TOOLS_BY_NAME } from '../src/tools/index.js';
import {
  ALLOWED_HOSTS,
  cached,
  cacheStats,
  clearCache,
  computeBackoffMs,
  DEFAULT_RETRY,
  fetchJson,
  isBotChallenge,
  PATIENT_RETRY,
} from '../src/lib/http.js';
import { assertValidPackageName, assertValidVersionSpec, normalizeLicense, normalizePerson, resolveVersion, shipsOwnTypes, typesPackageName, type Packument } from '../src/lib/npm.js';
import { ToolError, describeError, optional } from '../src/lib/errors.js';
import { mapLimit } from '../src/lib/concurrency.js';
import { SERVER_NAME, SERVER_VERSION, USER_AGENT } from '../src/lib/version.js';

const EXPECTED_TOOLS = [
  'inspect_package',
  'list_versions',
  'dependency_tree',
  'check_vulnerabilities',
  'package_size',
  'compare_versions',
  'analyze_supply_chain',
  'search_packages',
  'download_stats',
];

describe('tool registry', () => {
  it('registers exactly the nine documented tools', () => {
    assert.deepEqual(
      TOOLS.map((tool) => tool.name),
      EXPECTED_TOOLS,
    );
  });

  it('gives every tool a title, a substantial description and a strict schema', () => {
    for (const tool of TOOLS) {
      assert.ok(tool.title.length > 0, `${tool.name} needs a title`);
      assert.ok(tool.description.length > 80, `${tool.name} needs a description that says when to use it`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name} must reject unknown properties`);
      assert.ok(Object.keys(tool.inputSchema.properties).length > 0);
    }
  });

  it('documents every required property in the schema', () => {
    for (const tool of TOOLS) {
      for (const required of tool.inputSchema.required ?? []) {
        assert.ok(
          Object.hasOwn(tool.inputSchema.properties, required),
          `${tool.name} requires "${required}" but does not describe it`,
        );
      }
    }
  });

  it('indexes tools by name', () => {
    assert.equal(TOOLS_BY_NAME.size, TOOLS.length);
    assert.equal(TOOLS_BY_NAME.get('inspect_package')?.title, 'Inspect npm package');
  });

  it('rejects invalid arguments before doing any I/O', async () => {
    const tool = TOOLS_BY_NAME.get('inspect_package');
    await assert.rejects(() => tool!.invoke({}), (err: unknown) => err instanceof ToolError && err.code === 'INVALID_INPUT');
    await assert.rejects(() => tool!.invoke({ name: 123 }), (err: unknown) => err instanceof ToolError);
  });

  it('rejects out-of-range numeric arguments', async () => {
    const tool = TOOLS_BY_NAME.get('dependency_tree');
    await assert.rejects(
      () => tool!.invoke({ name: 'lodash', depth: 99 }),
      (err: unknown) => err instanceof ToolError && err.code === 'INVALID_INPUT',
    );
  });

  it('rejects an unknown enum value', async () => {
    const tool = TOOLS_BY_NAME.get('download_stats');
    await assert.rejects(
      () => tool!.invoke({ name: 'lodash', period: 'last-decade' }),
      (err: unknown) => err instanceof ToolError,
    );
  });
});

describe('network allowlist', () => {
  it('lists exactly the four documented hosts', () => {
    assert.deepEqual([...ALLOWED_HOSTS].sort(), [
      'api.npmjs.org',
      'api.osv.dev',
      'bundlephobia.com',
      'registry.npmjs.org',
    ]);
  });

  it('refuses any other host without opening a connection', async () => {
    await assert.rejects(
      () => fetchJson('https://example.com/data.json'),
      (err: unknown) => err instanceof ToolError && /disallowed host/.test(err.message),
    );
  });

  it('refuses plain http even to an allowed host', async () => {
    await assert.rejects(
      () => fetchJson('http://registry.npmjs.org/lodash'),
      (err: unknown) => err instanceof ToolError && /non-https/.test(err.message),
    );
  });

  it('refuses a lookalike host', async () => {
    await assert.rejects(
      () => fetchJson('https://registry.npmjs.org.evil.example/lodash'),
      (err: unknown) => err instanceof ToolError,
    );
  });

  // These hostnames appear in the source as strings — repository URLs that
  // `normalizeRepositoryUrl` builds for display, the project HOMEPAGE in the
  // User-Agent, and the `source` attribution on advisories. Scanners flag them
  // as outbound hosts; these assertions prove they are not reachable.
  it('refuses the code-hosting and attribution hosts that appear only as data', async () => {
    for (const url of [
      'https://github.com/lodash/lodash',
      'https://gitlab.com/a/b',
      'https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm',
      'https://raw.githubusercontent.com/a/b/main/package.json',
    ]) {
      await assert.rejects(
        () => fetchJson(url),
        (err: unknown) => err instanceof ToolError && /disallowed host/.test(err.message),
        `${url} must not be reachable`,
      );
    }
  });

  it('routes every network call through the single guarded fetch in http.ts', () => {
    // The README claims exactly one fetch() call site. Keep that true.
    const sourceDir = resolve(process.cwd(), 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) files.push(full);
      }
    };
    walk(sourceDir);

    const callSites = files.filter((file) => /(?<![.\w])fetch\s*\(/.test(readFileSync(file, 'utf8')));
    assert.deepEqual(
      callSites.map((file) => file.slice(sourceDir.length + 1)),
      ['lib/http.ts'],
      'a new fetch() appeared outside the allowlisted wrapper',
    );
  });
});

describe('bot-challenge detection', () => {
  const headers = (init: Record<string, string>): Headers => new Headers(init);

  it("recognises Vercel's challenge, which arrives as a 429", () => {
    assert.equal(
      isBotChallenge(429, headers({ 'x-vercel-mitigated': 'challenge', 'content-type': 'text/html; charset=utf-8' })),
      true,
    );
    assert.equal(isBotChallenge(429, headers({ 'x-vercel-challenge-token': 'abc' })), true);
  });

  it("recognises Cloudflare's equivalent", () => {
    assert.equal(isBotChallenge(403, headers({ 'cf-mitigated': 'challenge' })), true);
    assert.equal(isBotChallenge(503, headers({ 'cf-chl-bypass': '1' })), true);
  });

  it('treats an HTML body on a 429 as a challenge, since we asked for JSON', () => {
    assert.equal(isBotChallenge(429, headers({ 'content-type': 'text/html' })), true);
  });

  it('does not mistake a genuine JSON rate limit for a challenge', () => {
    // This must still go down the retry path.
    assert.equal(isBotChallenge(429, headers({ 'content-type': 'application/json', 'retry-after': '1' })), false);
    assert.equal(isBotChallenge(503, headers({ 'content-type': 'application/json' })), false);
  });

  it('ignores successful and not-found responses entirely', () => {
    assert.equal(isBotChallenge(200, headers({ 'content-type': 'text/html' })), false);
    assert.equal(isBotChallenge(404, headers({ 'content-type': 'text/html' })), false);
  });
});

describe('retry backoff', () => {
  // jitter = 0 makes the schedule deterministic.
  const noJitter = 0;

  it('doubles the delay on each successive retry', () => {
    assert.equal(computeBackoffMs(1, DEFAULT_RETRY, null, noJitter), 500);
    assert.equal(computeBackoffMs(2, DEFAULT_RETRY, null, noJitter), 1000);
    assert.equal(computeBackoffMs(3, DEFAULT_RETRY, null, noJitter), 2000);
  });

  it('never exceeds maxDelayMs', () => {
    assert.equal(computeBackoffMs(9, DEFAULT_RETRY, null, noJitter), DEFAULT_RETRY.maxDelayMs);
    assert.equal(computeBackoffMs(9, PATIENT_RETRY, null, noJitter), PATIENT_RETRY.maxDelayMs);
  });

  it("prefers the server's Retry-After over the exponential guess", () => {
    assert.equal(computeBackoffMs(1, DEFAULT_RETRY, 1500, noJitter), 1500);
  });

  it('caps an unreasonably long Retry-After instead of stalling the tool call', () => {
    // A server asking for 5 minutes must not block a tool call for 5 minutes.
    assert.equal(computeBackoffMs(1, DEFAULT_RETRY, 300_000, noJitter), DEFAULT_RETRY.maxDelayMs);
  });

  it('treats Retry-After: 0 as a valid immediate retry', () => {
    assert.equal(computeBackoffMs(1, DEFAULT_RETRY, 0, noJitter), 0);
  });

  it('adds up to 25% jitter so parallel callers do not retry in lockstep', () => {
    assert.equal(computeBackoffMs(1, DEFAULT_RETRY, null, 1), 625); // 500 * 1.25
    assert.equal(computeBackoffMs(1, DEFAULT_RETRY, null, 0.5), 563);
    // Out-of-range jitter is clamped rather than trusted.
    assert.equal(computeBackoffMs(1, DEFAULT_RETRY, null, 99), 625);
    assert.equal(computeBackoffMs(1, DEFAULT_RETRY, null, -5), 500);
  });

  it('gives the rate-limiting size services a longer schedule than the default', () => {
    assert.ok(PATIENT_RETRY.attempts > DEFAULT_RETRY.attempts);
    assert.ok(PATIENT_RETRY.maxTotalDelayMs > DEFAULT_RETRY.maxTotalDelayMs);

    // Worst case the extra attempts must stay within the total budget.
    let spent = 0;
    for (let attempt = 1; attempt < PATIENT_RETRY.attempts; attempt++) {
      spent += computeBackoffMs(attempt, PATIENT_RETRY, null, 1);
    }
    assert.ok(spent <= PATIENT_RETRY.maxTotalDelayMs, `worst-case backoff ${spent}ms exceeds the budget`);
  });
});

describe('package name validation', () => {
  it('accepts ordinary and scoped names', () => {
    assert.equal(assertValidPackageName('lodash'), 'lodash');
    assert.equal(assertValidPackageName('@scope/name'), '@scope/name');
    assert.equal(assertValidPackageName('  lodash  '), 'lodash');
    assert.equal(assertValidPackageName('JSONStream'), 'JSONStream'); // legacy uppercase
  });

  it('rejects path traversal and separators', () => {
    for (const bad of ['../etc/passwd', 'a/../../b', 'foo/bar/baz', 'a b', '', '.hidden', '_private']) {
      assert.throws(() => assertValidPackageName(bad), ToolError, `expected "${bad}" to be rejected`);
    }
  });

  it('rejects over-long names', () => {
    assert.throws(() => assertValidPackageName('a'.repeat(215)), ToolError);
  });

  it('validates version specs', () => {
    assert.equal(assertValidVersionSpec('1.2.3'), '1.2.3');
    assert.equal(assertValidVersionSpec('latest'), 'latest');
    assert.equal(assertValidVersionSpec('1.0.0-beta.1+build'), '1.0.0-beta.1+build');
    for (const bad of ['../1.0.0', '1.0.0/../..', '', 'a'.repeat(129)]) {
      assert.throws(() => assertValidVersionSpec(bad), ToolError);
    }
  });
});

describe('resolveVersion', () => {
  const packument: Packument = {
    name: 'demo',
    description: null,
    distTags: { latest: '2.0.0', next: '3.0.0-beta.1' },
    versions: ['1.0.0', '2.0.0', '3.0.0-beta.1'],
    time: {},
    deprecatedVersions: {},
    license: null,
    homepage: null,
    repository: null,
    bugs: null,
    keywords: [],
    author: null,
    maintainers: [],
    readmeFilename: null,
  };

  it('defaults to latest', () => {
    assert.deepEqual(resolveVersion(packument), { requested: 'latest', version: '2.0.0', fromDistTag: true });
  });

  it('resolves other dist-tags', () => {
    assert.equal(resolveVersion(packument, 'next').version, '3.0.0-beta.1');
  });

  it('resolves exact versions', () => {
    assert.deepEqual(resolveVersion(packument, '1.0.0'), { requested: '1.0.0', version: '1.0.0', fromDistTag: false });
  });

  it('throws a helpful NOT_FOUND for an unknown version', () => {
    assert.throws(
      () => resolveVersion(packument, '9.9.9'),
      (err: unknown) =>
        err instanceof ToolError && err.code === 'NOT_FOUND' && /does not exist/.test(err.message) && /2\.0\.0/.test(err.hint ?? ''),
    );
  });

  it('falls back to the highest version when there is no latest tag', () => {
    const untagged: Packument = { ...packument, distTags: {} };
    assert.equal(resolveVersion(untagged).version, '2.0.0');
  });
});

describe('manifest normalisation', () => {
  it('normalises the license field in all its shapes', () => {
    assert.equal(normalizeLicense('MIT'), 'MIT');
    assert.equal(normalizeLicense({ type: 'ISC' }), 'ISC');
    assert.equal(normalizeLicense(['MIT', 'Apache-2.0']), 'MIT OR Apache-2.0');
    assert.equal(normalizeLicense(null), null);
    assert.equal(normalizeLicense(''), null);
  });

  it('normalises the author field', () => {
    assert.equal(normalizePerson('Ada <ada@example.com>'), 'Ada <ada@example.com>');
    assert.equal(normalizePerson({ name: 'Ada' }), 'Ada');
    assert.equal(normalizePerson(null), null);
  });

  it('detects bundled TypeScript types', () => {
    assert.equal(shipsOwnTypes({ name: 'a', version: '1.0.0', types: './index.d.ts' }), true);
    assert.equal(shipsOwnTypes({ name: 'a', version: '1.0.0', typings: './index.d.ts' }), true);
    assert.equal(
      shipsOwnTypes({ name: 'a', version: '1.0.0', exports: { '.': { types: './i.d.ts', default: './i.js' } } }),
      true,
    );
    assert.equal(shipsOwnTypes({ name: 'a', version: '1.0.0' }), false);
  });

  it('builds the DefinitelyTyped package name', () => {
    assert.equal(typesPackageName('lodash'), '@types/lodash');
    assert.equal(typesPackageName('@babel/core'), '@types/babel__core');
  });
});

describe('TTL cache', () => {
  it('memoizes within the TTL and re-runs after it expires', async () => {
    clearCache();
    let calls = 0;
    const producer = async (): Promise<number> => {
      calls += 1;
      return calls;
    };

    assert.equal(await cached('k', 60_000, producer), 1);
    assert.equal(await cached('k', 60_000, producer), 1);
    assert.equal(calls, 1);

    // A zero TTL expires immediately.
    await cached('k2', 0, producer);
    await cached('k2', 0, producer);
    assert.equal(calls, 3);
  });

  it('collapses concurrent callers onto one in-flight request', async () => {
    clearCache();
    let calls = 0;
    const producer = async (): Promise<string> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'value';
    };

    const results = await Promise.all([
      cached('shared', 60_000, producer),
      cached('shared', 60_000, producer),
      cached('shared', 60_000, producer),
    ]);

    assert.deepEqual(results, ['value', 'value', 'value']);
    assert.equal(calls, 1);
  });

  it('does not cache rejections', async () => {
    clearCache();
    let calls = 0;
    const failing = async (): Promise<never> => {
      calls += 1;
      throw new Error('boom');
    };

    await assert.rejects(() => cached('bad', 60_000, failing));
    await assert.rejects(() => cached('bad', 60_000, failing));
    assert.equal(calls, 2);
  });

  it('reports and clears its own state', async () => {
    clearCache();
    await cached('x', 60_000, async () => 1);
    assert.equal(cacheStats().entries, 1);
    clearCache();
    assert.equal(cacheStats().entries, 0);
  });
});

describe('error handling', () => {
  it('describes ToolErrors with their code and hint', () => {
    const described = describeError(new ToolError('NOT_FOUND', 'gone', 'try again'));
    assert.deepEqual(described, { code: 'NOT_FOUND', message: 'gone', hint: 'try again' });
  });

  it('maps abort and timeout errors onto TIMEOUT', () => {
    const err = new Error('aborted');
    err.name = 'TimeoutError';
    assert.equal(describeError(err).code, 'TIMEOUT');
  });

  it('describes non-Error throwables', () => {
    assert.equal(describeError('just a string').code, 'INTERNAL');
  });

  it('turns an optional source failure into a note instead of throwing', async () => {
    const failed = await optional('bundlephobia', async () => {
      throw new ToolError('UPSTREAM_UNAVAILABLE', 'service down');
    });
    assert.equal(failed.value, null);
    assert.equal(failed.note, 'bundlephobia: service down');

    const ok = await optional('npm', async () => 42);
    assert.equal(ok.value, 42);
    assert.equal(ok.note, null);
  });
});

describe('mapLimit', () => {
  it('preserves input order', async () => {
    const result = await mapLimit([5, 1, 3], 2, async (value) => {
      await new Promise((resolve) => setTimeout(resolve, value));
      return value * 2;
    });
    assert.deepEqual(result, [10, 2, 6]);
  });

  it('never exceeds the concurrency limit', async () => {
    let active = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 3, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value;
    });
    assert.ok(peak <= 3, `peak concurrency was ${peak}`);
  });

  it('handles an empty list', async () => {
    assert.deepEqual(await mapLimit([], 4, async (value) => value), []);
  });
});

describe('server identity', () => {
  it('keeps the hardcoded version in sync with package.json', () => {
    // `npm test` always runs from the repo root.
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      name: string;
      version: string;
    };
    assert.equal(pkg.name, SERVER_NAME);
    assert.equal(pkg.version, SERVER_VERSION);
  });

  it('sends a descriptive, contactable User-Agent', () => {
    assert.match(USER_AGENT, /^package-inspector\/\d+\.\d+\.\d+ \(\+https:\/\/.+\)$/);
  });
});
