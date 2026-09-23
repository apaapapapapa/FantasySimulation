import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { contextPlan, CONTEXT_TOPICS, inspectContext } from './context.ts';
import { testRepository } from './test-support/repository.ts';
import { qualityPaths } from '../quality/files.ts';
import { classify } from '../ci/plan.ts';

function contextRepository(extra: Record<string, string> = {}) {
  const files: Record<string, string> = {
    'AGENTS.md': '# Rules\n',
    'README.md': '# Start\n',
    '.agents/skills/fantasy-delivery/SKILL.md': '# Delivery\n',
  };
  for (const route of Object.values(CONTEXT_TOPICS)) {
    for (const path of route.docs) files[path] = '# Reference\n';
    for (const path of route.sources)
      files[path.endsWith('.ts') ? path : `${path}/fixture.ts`] = 'export {};\n';
  }
  return testRepository({ ...files, ...extra });
}

describe('bounded context navigation', () => {
  it('returns only task paths and focused commands, rejecting unknown topics', () => {
    const result = contextPlan('engine');
    expect(result).toContain('packages/engine/src');
    expect(result).toContain('docs/adr/0010-battle-version-compatibility.md');
    expect(result).not.toContain('docs/security.md');
    for (const topic of ['list', ...Object.keys(CONTEXT_TOPICS)])
      expect(Buffer.byteLength(contextPlan(topic))).toBeLessThanOrEqual(2000);
    expect(() => contextPlan('constructor')).toThrow('Unknown context topic');
    expect(() => contextPlan('all')).toThrow('Unknown context topic');
  });

  it('works from the Node-only CLI and rejects extra arguments', () => {
    const command = ['scripts/harness.ts', 'context', 'engine'];
    const result = spawnSync(process.execPath, command, { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Task: engine');
    expect(spawnSync(process.execPath, [...command, '--all']).status).toBe(2);
  });
});

describe('documentation budgets and navigation', () => {
  it('counts UTF-8 bytes and accepts the exact single-document limit', () => {
    const project = contextRepository({ 'docs/boundary.md': 'あ'.repeat(10666) + 'ab' });
    try {
      const result = inspectContext(project.root, qualityPaths(project.root));
      expect(result.findings).toEqual([]);
      expect(result.files.find((file) => file.path === 'docs/boundary.md')?.bytes).toBe(32000);
      writeFileSync(join(project.root, 'docs/boundary.md'), 'あ'.repeat(10667));
      expect(inspectContext(project.root, qualityPaths(project.root)).findings).toEqual([
        { path: 'docs/boundary.md', reason: '32001 bytes exceeds 32000' },
      ]);
    } finally {
      project.dispose();
    }
  });

  it('detects newly added local instruction files before staging', () => {
    const project = contextRepository();
    try {
      const path = 'apps/api/AGENTS.md';
      mkdirSync(dirname(join(project.root, path)), { recursive: true });
      writeFileSync(join(project.root, path), 'a'.repeat(6001));
      expect(inspectContext(project.root, qualityPaths(project.root)).findings).toContainEqual({
        path,
        reason: '6001 bytes exceeds 6000',
      });
    } finally {
      project.dispose();
    }
  });

  it('rejects aggregate growth even when individual documents fit', () => {
    const project = contextRepository({
      'AGENTS.md': 'a'.repeat(5000),
      'README.md': 'b'.repeat(5000),
      '.agents/skills/fantasy-delivery/SKILL.md': 'c'.repeat(5000),
      ...Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [`docs/extra-${i}.md`, 'x'.repeat(30000)]),
      ),
    });
    try {
      const result = inspectContext(project.root, qualityPaths(project.root));
      expect(result.findings.map((finding) => finding.path)).toEqual([
        'all documentation',
        'entrypoints',
      ]);
    } finally {
      project.dispose();
    }
  });

  it('checks incoming links in unchanged docs after a target is removed', () => {
    const project = contextRepository({
      'docs/guide.md': '[obsolete](obsolete.md)\n[web](https://example.com)\n[anchor](#section)\n',
      'docs/obsolete.md': '# Old\n',
    });
    try {
      rmSync(join(project.root, 'docs/obsolete.md'));
      expect(inspectContext(project.root, qualityPaths(project.root)).findings).toContainEqual({
        path: 'docs/guide.md: obsolete.md',
        reason: 'Broken local inline link',
      });
      rmSync(join(project.root, 'docs/adr/0005-drizzle-kit.md'));
      expect(inspectContext(project.root, qualityPaths(project.root)).findings).toContainEqual({
        path: 'docs/adr/0005-drizzle-kit.md',
        reason: 'Missing context target',
      });
    } finally {
      project.dispose();
    }
  });

  it.each(['existing', 'dangling'] as const)(
    'rejects empty coverage and %s Markdown symlinks',
    (kind) => {
      const project = contextRepository();
      try {
        expect(() => inspectContext(project.root, [])).toThrow('coverage is empty');
        symlinkSync(
          kind === 'existing' ? resolve('README.md') : join(project.root, 'missing.md'),
          join(project.root, 'docs/external.md'),
        );
        project.git('add', 'docs/external.md');
        expect(() => inspectContext(project.root, qualityPaths(project.root))).toThrow(
          'inside the repository',
        );
      } finally {
        project.dispose();
      }
    },
  );

  it('returns a failing CLI status when a budget is exceeded', () => {
    const project = contextRepository({ 'docs/oversized.md': 'x'.repeat(32001) });
    try {
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/harness.ts'), 'context', 'check'],
        {
          cwd: project.root,
          encoding: 'utf8',
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('32001 bytes exceeds 32000');
      // No generated output or repository mutation is needed to navigate/check.
      expect(
        execFileSync('git', ['status', '--porcelain'], { cwd: project.root, encoding: 'utf8' }),
      ).toBe('');
    } finally {
      project.dispose();
    }
  });

  it('blocks the dependency-free Docs CI shortcut on entrypoint growth', () => {
    const project = contextRepository();
    try {
      const base = project.git('rev-parse', 'HEAD').trim();
      writeFileSync(join(project.root, 'README.md'), 'x'.repeat(15000) + '\n');
      project.git('add', 'README.md');
      project.git('commit', '-m', 'docs: grow entrypoint');
      const head = project.git('rev-parse', 'HEAD').trim();
      const plan = classify(
        { sourceSha: head, candidateSha: head, testMergeSha: head, baselineSha: base },
        'pull_request',
        ['README.md'],
      );
      const directory = join(project.root, '.generated/harness/ci');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'plan.json'), JSON.stringify(plan));
      const result = spawnSync(process.execPath, [resolve('scripts/ci/docs.ts')], {
        cwd: project.root,
        encoding: 'utf8',
        env: { ...process.env, GITHUB_SHA: head },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('"id":"docs:context","required":true,"status":"fail"');
      expect(result.stdout).toContain('"id":"docs:diff","required":true,"status":"pass"');
      expect(result.stdout).toContain('"id":"docs:links","required":true,"status":"pass"');
    } finally {
      project.dispose();
    }
  });
});
