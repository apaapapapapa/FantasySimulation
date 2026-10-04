import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createTestProject } from '../quality/test-support/project.ts';
import { auditOutcome } from './audit.ts';
import { verifyBracesRegression, verifyInstalledBraces } from './braces-patch.ts';

function auditFixture() {
  return {
    advisories: {
      known: {
        github_advisory_id: 'GHSA-vfj7-8cjw-p6xm',
        module_name: 'braces',
        severity: 'high',
        vulnerable_versions: '<=3.0.3',
        cwe: 'CWE-674',
        title:
          'braces vulnerable to stack-exhaustion denial of service through deeply nested patterns',
        patched_versions: null,
        patched_versions_unpublished: true,
        findings: [
          {
            version: '3.0.3',
            dev: true,
            optional: false,
            bundled: false,
            paths: [
              '.>@semantic-release/commit-analyzer>micromatch>braces',
              '.>@semantic-release/commit-analyzer>semantic-release>micromatch>braces',
              '.>@semantic-release/github>semantic-release>@semantic-release/commit-analyzer>micromatch>braces',
              '.>@semantic-release/github>semantic-release>micromatch>braces',
              '.>@semantic-release/release-notes-generator>semantic-release>@semantic-release/commit-analyzer>micromatch>braces',
              '.>@semantic-release/release-notes-generator>semantic-release>micromatch>braces',
              '.>semantic-release>@semantic-release/commit-analyzer>micromatch>braces',
              '.>semantic-release>micromatch>braces',
            ],
          },
        ],
      },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 1, high: 1, critical: 0 } },
  };
}

function installedFixture() {
  const paths = [
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'node_modules/.pnpm/lock.yaml',
    'patches/braces@3.0.3.patch',
    'scripts/security/braces.test.ts',
  ];
  const project = createTestProject(
    Object.fromEntries(paths.map((path) => [path, readFileSync(path, 'utf8')])),
  );
  try {
    const modules = join(project.root, 'node_modules');
    for (const name of [
      'semantic-release',
      '@semantic-release/commit-analyzer',
      '@semantic-release/github',
      '@semantic-release/release-notes-generator',
      'micromatch',
    ]) {
      const directory = join(modules, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
      writeFileSync(join(directory, 'index.js'), 'module.exports = {};\n');
    }
    const consumer = createRequire(import.meta.resolve('semantic-release'));
    const braces = createRequire(consumer.resolve('micromatch')).resolve('braces');
    cpSync(dirname(braces), join(modules, 'braces'), { recursive: true });
    return project;
  } catch (error) {
    project.dispose();
    throw error;
  }
}

await test('recognition verifies actual installed bytes and executes all seven regressions', () => {
  const result = auditOutcome(auditFixture(), 1);
  assert.equal(result.status, 'pass');
  assert.equal(result.reason, 'VERIFIED_BRACES_RECURSION_PATCH');
  assert.deepEqual(result.counts, {
    info: 0,
    low: 0,
    moderate: 1,
    high: 1,
    critical: 0,
    verifiedBraces: 1,
    blocking: 0,
  });
});

await test('other advisories and every critical finding still block after recognition', () => {
  for (const severity of ['high', 'critical'] as const) {
    const report = auditFixture();
    Object.assign(report.advisories, {
      other: { ...report.advisories.known, github_advisory_id: 'GHSA-other', severity },
    });
    report.metadata.vulnerabilities[severity]++;
    let checked = 0;
    const result = auditOutcome(report, 1, () => {
      checked++;
    });
    assert.equal(checked, 1);
    assert.equal(result.status, 'fail');
    assert.equal(result.counts.blocking, 1);
  }
});

await test('changed advisory scope, release availability and dependency routes receive no recognition', () => {
  for (const change of [
    { github_advisory_id: 'GHSA-other' },
    { module_name: 'other' },
    { vulnerable_versions: '<=3.0.4' },
    { cwe: 'CWE-999' },
    { title: 'Changed vulnerability' },
    { patched_versions: '>=3.0.4' },
    { patched_versions_unpublished: false },
    { findings: [] },
    ...[
      { version: '3.0.2' },
      { dev: false },
      { optional: true },
      { bundled: true },
      { paths: ['.>other>braces'] },
      { paths: [] },
    ].map((change) => ({
      findings: [{ ...auditFixture().advisories.known.findings[0], ...change }],
    })),
  ]) {
    const report = auditFixture();
    Object.assign(report.advisories.known, change);
    assert.equal(
      auditOutcome(report, 1, () => assert.fail('unexpected recognition')).status,
      'fail',
    );
  }
  const duplicate = auditFixture();
  const paths = duplicate.advisories.known.findings[0]!.paths;
  paths[0] = paths[1]!;
  assert.equal(auditOutcome(duplicate, 1, () => assert.fail('duplicate route')).status, 'fail');
});

await test('missing execution, inconsistent inventory and duplicate advisories cannot pass', () => {
  assert.throws(() =>
    auditOutcome(auditFixture(), 1, () => {
      throw new Error('verification failed');
    }),
  );
  assert.throws(() => auditOutcome(auditFixture(), 0, () => assert.fail('bad exit')));
  const inconsistent = auditFixture();
  inconsistent.metadata.vulnerabilities.high = 2;
  assert.throws(() => auditOutcome(inconsistent, 1, () => assert.fail('bad inventory')));
  Object.assign(inconsistent.advisories, {
    duplicate: structuredClone(inconsistent.advisories.known),
  });
  assert.equal(
    auditOutcome(inconsistent, 1, () => assert.fail('duplicate advisory')).status,
    'fail',
  );
});

await test('patch, regression, wanted/installed lockfiles and every runtime file are mandatory', () => {
  const fixture = installedFixture();
  try {
    verifyInstalledBraces(fixture.root);
    for (const name of [
      'pnpm-workspace.yaml',
      'pnpm-lock.yaml',
      'node_modules/.pnpm/lock.yaml',
      'patches/braces@3.0.3.patch',
      'scripts/security/braces.test.ts',
      ...[
        'package.json',
        'index.js',
        'lib/compile.js',
        'lib/constants.js',
        'lib/expand.js',
        'lib/parse.js',
        'lib/stringify.js',
        'lib/utils.js',
      ].map((name) => 'node_modules/braces/' + name),
    ]) {
      const file = join(fixture.root, name),
        original = readFileSync(file);
      try {
        writeFileSync(file, name.endsWith('.yaml') ? '{}' : '// changed or unapplied\n');
        assert.throws(() => verifyInstalledBraces(fixture.root), name);
      } finally {
        writeFileSync(file, original);
      }
    }
  } finally {
    fixture.dispose();
  }
});

await test('a second reachable unpatched copy cannot hide behind a good root copy', () => {
  const fixture = installedFixture();
  try {
    const modules = join(fixture.root, 'node_modules');
    const nested = join(modules, 'semantic-release/node_modules/micromatch');
    cpSync(join(modules, 'micromatch'), nested, { recursive: true });
    cpSync(join(modules, 'braces'), join(nested, 'node_modules/braces'), { recursive: true });
    verifyInstalledBraces(fixture.root);
    writeFileSync(join(nested, 'node_modules/braces/lib/parse.js'), '// old implementation\n');
    assert.throws(() => verifyInstalledBraces(fixture.root), /BRACES_INSTALLED_BYTES/);
  } finally {
    fixture.dispose();
  }
});

await test('regression cancellation, nonzero exit, skips and partial output fail closed', () => {
  const success = {
    signal: null,
    status: 0,
    stderr: '',
    stdout: '# tests 7\n# pass 7\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
  };
  verifyBracesRegression(success);
  for (const changed of [
    { status: 1 },
    { status: null },
    { error: new Error('offline') },
    { signal: 'SIGTERM' as const },
    { stderr: 'unexpected error' },
    { stdout: '' },
    { stdout: success.stdout.replace('# pass 7', '# pass 6') },
    { stdout: success.stdout.replace('# skipped 0', '# skipped 1') },
    { stdout: success.stdout + '# tests 7\n' },
  ])
    assert.throws(() => verifyBracesRegression({ ...success, ...changed }));
});
