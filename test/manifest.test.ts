import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ManifestParseError, packageNameFromLockPath, parseManifest } from '../src/lib/manifest.js';
import { buildActions, type AuditedDependency } from '../src/tools/audit-dependencies.js';

const json = (value: unknown): string => JSON.stringify(value);

describe('parseManifest — package.json', () => {
  const pkg = {
    name: 'my-app',
    version: '2.1.0',
    dependencies: { lodash: '^4.17.21', express: '~4.18.0' },
    devDependencies: { typescript: '^5.0.0' },
    optionalDependencies: { fsevents: '^2.3.0' },
    peerDependencies: { react: '>=18' },
  };

  it('reads direct dependencies and project identity', () => {
    const parsed = parseManifest(json(pkg));
    assert.equal(parsed.source, 'package.json');
    assert.equal(parsed.projectName, 'my-app');
    assert.equal(parsed.projectVersion, '2.1.0');
    assert.equal(parsed.transitive, false, 'a package.json only declares direct deps');
    assert.deepEqual(
      parsed.dependencies.map((d) => `${d.name}@${d.spec}`).sort(),
      ['express@~4.18.0', 'fsevents@^2.3.0', 'lodash@^4.17.21', 'react@>=18'],
    );
  });

  it('marks specs as ranges needing resolution', () => {
    assert.equal(parseManifest(json(pkg)).dependencies.every((d) => d.exact === false), true);
  });

  it('excludes devDependencies unless asked', () => {
    assert.equal(parseManifest(json(pkg)).dependencies.some((d) => d.name === 'typescript'), false);
    const withDev = parseManifest(json(pkg), { includeDev: true });
    assert.equal(withDev.dependencies.find((d) => d.name === 'typescript')?.kind, 'dev');
  });

  it('classifies each dependency kind', () => {
    const parsed = parseManifest(json(pkg));
    const kinds = Object.fromEntries(parsed.dependencies.map((d) => [d.name, d.kind]));
    assert.equal(kinds.lodash, 'prod');
    assert.equal(kinds.fsevents, 'optional');
    assert.equal(kinds.react, 'peer');
  });

  it('skips specifiers that cannot be looked up on the registry', () => {
    const parsed = parseManifest(
      json({
        dependencies: {
          ok: '^1.0.0',
          fromGit: 'git+https://github.com/a/b.git',
          local: 'file:../thing',
          ws: 'workspace:*',
        },
      }),
    );
    assert.deepEqual(parsed.dependencies.map((d) => d.name), ['ok']);
    assert.deepEqual(parsed.skipped.map((s) => s.name).sort(), ['fromGit', 'local', 'ws']);
    assert.match(parsed.skipped.find((s) => s.name === 'fromGit')!.reason, /git/i);
  });

  it('keeps dist-tag specs, which the registry can still resolve', () => {
    const parsed = parseManifest(json({ dependencies: { pkg: 'latest' } }));
    assert.deepEqual(parsed.dependencies.map((d) => d.spec), ['latest']);
    assert.equal(parsed.skipped.length, 0);
  });

  it('counts a package appearing in two groups once', () => {
    const parsed = parseManifest(json({ dependencies: { dual: '^1.0.0' }, peerDependencies: { dual: '^1.0.0' } }));
    assert.equal(parsed.dependencies.length, 1);
  });
});

describe('parseManifest — lockfile v2/v3', () => {
  const lock = {
    name: 'my-app',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'my-app', version: '1.0.0' },
      'node_modules/lodash': { version: '4.17.15', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.15.tgz' },
      'node_modules/ms': { version: '2.1.3' },
      'node_modules/debug/node_modules/ms': { version: '2.0.0' },
      'node_modules/typescript': { version: '5.4.0', dev: true },
      'node_modules/fsevents': { version: '2.3.3', optional: true },
    },
  };

  it('covers the whole installed tree at exact versions', () => {
    const parsed = parseManifest(json(lock));
    assert.equal(parsed.source, 'package-lock.json');
    assert.equal(parsed.lockfileVersion, 3);
    assert.equal(parsed.transitive, true);
    assert.equal(parsed.dependencies.every((d) => d.exact), true, 'lockfile versions need no resolution');
  });

  it('keeps both copies when a package is installed at two versions', () => {
    const versions = parseManifest(json(lock))
      .dependencies.filter((d) => d.name === 'ms')
      .map((d) => d.spec)
      .sort();
    assert.deepEqual(versions, ['2.0.0', '2.1.3'], 'nested copies are each separately installed');
  });

  it('derives the name from the install path when absent', () => {
    const nested = parseManifest(json(lock)).dependencies.find((d) => d.path?.includes('debug/node_modules/ms'));
    assert.equal(nested?.name, 'ms');
  });

  it('honours the dev flag', () => {
    assert.equal(parseManifest(json(lock)).dependencies.some((d) => d.name === 'typescript'), false);
    assert.equal(parseManifest(json(lock), { includeDev: true }).dependencies.some((d) => d.name === 'typescript'), true);
  });

  it('skips workspace links and non-registry resolutions', () => {
    const parsed = parseManifest(
      json({
        lockfileVersion: 3,
        packages: {
          '': { name: 'root' },
          'node_modules/linked': { resolved: 'packages/linked', link: true },
          'node_modules/tarball': { version: '1.0.0', resolved: 'https://example.com/x.tgz' },
          'node_modules/normal': { version: '1.0.0' },
        },
      }),
    );
    assert.deepEqual(parsed.dependencies.map((d) => d.name), ['normal']);
    assert.deepEqual(parsed.skipped.map((s) => s.name), ['tarball']);
  });

  it('excludes the root project entry', () => {
    assert.equal(parseManifest(json(lock)).dependencies.some((d) => d.name === 'my-app'), false);
  });
});

describe('parseManifest — lockfile v1', () => {
  it('walks the nested dependencies map', () => {
    const parsed = parseManifest(
      json({
        name: 'legacy',
        lockfileVersion: 1,
        dependencies: {
          a: { version: '1.0.0', dependencies: { b: { version: '2.0.0' } } },
          c: { version: '3.0.0', dev: true },
        },
      }),
    );
    assert.equal(parsed.transitive, true);
    assert.deepEqual(parsed.dependencies.map((d) => d.name).sort(), ['a', 'b']);
    assert.equal(parsed.dependencies.every((d) => d.exact), true);
  });
});

describe('parseManifest — errors', () => {
  it('rejects empty input', () => {
    assert.throws(() => parseManifest(''), ManifestParseError);
    assert.throws(() => parseManifest('   '), ManifestParseError);
  });

  it('rejects malformed JSON with a message that says what to paste', () => {
    assert.throws(
      () => parseManifest('{ not json'),
      (err: unknown) => err instanceof ManifestParseError && /raw file contents/.test(err.message),
    );
  });

  it('rejects a JSON array or scalar', () => {
    assert.throws(() => parseManifest('[]'), ManifestParseError);
    assert.throws(() => parseManifest('42'), ManifestParseError);
  });

  it('rejects an object with no dependency fields at all', () => {
    assert.throws(
      () => parseManifest(json({ name: 'x', version: '1.0.0' })),
      (err: unknown) => err instanceof ManifestParseError && /No dependencies found/.test(err.message),
    );
  });

  it('accepts a package.json with an empty dependencies object', () => {
    const parsed = parseManifest(json({ name: 'x', dependencies: {} }));
    assert.deepEqual(parsed.dependencies, []);
  });
});

describe('packageNameFromLockPath', () => {
  it('takes the last node_modules segment', () => {
    assert.equal(packageNameFromLockPath('node_modules/lodash'), 'lodash');
    assert.equal(packageNameFromLockPath('node_modules/a/node_modules/b'), 'b');
    assert.equal(packageNameFromLockPath('node_modules/@scope/name'), '@scope/name');
    assert.equal(packageNameFromLockPath('packages/local'), null);
  });
});

describe('buildActions', () => {
  const dep = (over: Partial<AuditedDependency>): AuditedDependency => ({
    name: 'x',
    spec: '^1.0.0',
    version: '1.0.0',
    kind: 'prod',
    clean: false,
    issues: [],
    vulnerabilities: [],
    highestSeverity: null,
    recommendedUpgrade: null,
    deprecated: null,
    installScripts: [],
    license: 'MIT',
    metadataChecked: true,
    ...over,
  });

  const vuln = { id: 'GHSA-x', severity: 'critical' } as unknown as AuditedDependency['vulnerabilities'][number];

  it('omits clean dependencies entirely', () => {
    assert.deepEqual(buildActions([dep({ name: 'fine', clean: true })]), []);
  });

  it('omits coverage gaps, which are unknowns rather than findings', () => {
    // A dependency whose metadata could not be fetched must not appear as work
    // to do — reporting a failed lookup as a defect is how false findings start.
    const gap = dep({
      name: 'unreadable',
      metadataChecked: false,
      issues: [{ kind: 'unresolved', severity: 'info', detail: 'Registry metadata could not be fetched.' }],
    });
    assert.deepEqual(buildActions([gap]), []);
  });

  it('still lists a real finding on a dependency that also has a gap', () => {
    const both = dep({
      name: 'mixed',
      deprecated: 'use something else',
      issues: [
        { kind: 'unresolved', severity: 'info', detail: 'partial' },
        { kind: 'deprecated', severity: 'medium', detail: 'Deprecated: use something else' },
      ],
    });
    assert.equal(buildActions([both]).length, 1);
  });

  it('ranks a critical vulnerability above a deprecation', () => {
    const actions = buildActions([
      dep({ name: 'old', deprecated: 'use something else' }),
      dep({ name: 'risky', vulnerabilities: [vuln], highestSeverity: 'critical' }),
    ]);
    assert.equal(actions[0]?.package.startsWith('risky'), true);
    assert.equal(actions[1]?.package.startsWith('old'), true);
  });

  it('ranks severity in order', () => {
    const actions = buildActions([
      dep({ name: 'low-risk', vulnerabilities: [vuln], highestSeverity: 'low' }),
      dep({ name: 'high-risk', vulnerabilities: [vuln], highestSeverity: 'high' }),
      dep({ name: 'critical-risk', vulnerabilities: [vuln], highestSeverity: 'critical' }),
    ]);
    assert.deepEqual(
      actions.map((a) => a.package.split('@')[0]),
      ['critical-risk', 'high-risk', 'low-risk'],
    );
  });

  it('recommends the concrete upgrade when one exists', () => {
    const [action] = buildActions([
      dep({ name: 'fixable', vulnerabilities: [vuln], highestSeverity: 'high', recommendedUpgrade: '4.17.21' }),
    ]);
    assert.match(action!.action, /Upgrade to 4\.17\.21/);
  });

  it('says so when no single version clears everything', () => {
    const [action] = buildActions([dep({ name: 'stuck', vulnerabilities: [vuln], highestSeverity: 'high' })]);
    assert.match(action!.action, /no single published version/);
  });

  it('tells you to review or skip an install script', () => {
    const [action] = buildActions([dep({ name: 'scripted', installScripts: ['postinstall'] })]);
    assert.match(action!.action, /--ignore-scripts/);
    assert.match(action!.reason, /postinstall/);
  });

  it('numbers actions from 1 and caps the list', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      dep({ name: `p${String(i).padStart(2, '0')}`, deprecated: 'old' }),
    );
    const actions = buildActions(many);
    assert.equal(actions.length, 25);
    assert.equal(actions[0]?.priority, 1);
    assert.equal(actions.at(-1)?.priority, 25);
  });
});
