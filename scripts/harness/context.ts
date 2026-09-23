import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { missingLocalLinks } from '../quality/markdown.ts';

// UTF-8 byte budgets, not tokenizer-specific token counts. Changes require policy review.
export const CONTEXT_POLICY = {
  totalBytes: 170_000,
  documentBytes: 32_000,
  instructionBytes: 6_000,
  entrypointBytes: 14_000,
  outputBytes: 2_000,
  entrypoints: ['AGENTS.md', 'README.md', '.agents/skills/fantasy-delivery/SKILL.md'],
} as const;

export const CONTEXT_TOPICS = {
  engine: {
    sources: ['packages/engine/src', 'packages/domain/src', 'packages/engine/test-support'],
    docs: ['docs/rules/spatial-v1.md', 'docs/adr/0010-battle-version-compatibility.md'],
    check: 'vp test run packages/engine packages/domain',
  },
  api: {
    sources: ['apps/api/src', 'packages/domain/src'],
    docs: ['docs/development/local-usage.md', 'docs/adr/0007-worker-runtime.md'],
    check: 'vp test run apps/api',
  },
  storage: {
    sources: ['apps/api/src/db', 'db/drizzle', 'data/spatial'],
    docs: ['docs/adr/0005-drizzle-kit.md', 'docs/adr/0010-battle-version-compatibility.md'],
    check: 'vp test run apps/api/src/drizzle.test.ts',
  },
  replay: {
    sources: ['apps/api/src', 'packages/domain/src'],
    docs: ['docs/adr/0006-recorded-replay.md', 'docs/adr/0010-battle-version-compatibility.md'],
    check: 'vp test run apps/api packages/domain',
  },
  web: {
    sources: ['apps/web/src', 'packages/domain/src'],
    docs: ['docs/development/local-usage.md'],
    check: 'vp run typecheck && vp run --filter @fantasy/web build',
  },
  batch: {
    sources: ['apps/api/src', 'scripts/harness'],
    docs: ['docs/adr/0008-headless-batch.md', 'docs/development/simulation-evidence.md'],
    check: 'vp test run apps/api',
  },
  harness: {
    sources: ['scripts/harness', 'scripts/quality'],
    docs: ['.github/harness/README.md', 'docs/development/duplication.md'],
    check: 'vp test run scripts/harness scripts/quality',
  },
  ci: {
    sources: ['scripts/ci', '.github/workflows', '.github/actions'],
    docs: ['docs/development/ci.md', 'docs/development/release.md'],
    check: 'vp test run scripts/ci && vp run security:test',
  },
  security: {
    sources: ['scripts/security', '.github/workflows'],
    docs: ['docs/security.md', 'docs/dependency-updates.md'],
    check: 'vp run security:test',
  },
  docs: {
    sources: ['scripts/harness/context.ts', 'scripts/ci/docs.ts'],
    docs: ['docs/development/ai-context.md'],
    check: 'node scripts/harness.ts context check',
  },
} as const;

export function contextPlan(topic: string): string {
  let output: string;
  if (topic === 'list') output = `Topics: ${Object.keys(CONTEXT_TOPICS).join(', ')}\n`;
  else {
    if (!Object.hasOwn(CONTEXT_TOPICS, topic)) throw Error(`Unknown context topic: ${topic}`);
    const route = CONTEXT_TOPICS[topic as keyof typeof CONTEXT_TOPICS];
    output =
      [
        `Task: ${topic}`,
        'Start: AGENTS.md; changes also require .agents/skills/fantasy-delivery/SKILL.md.',
        `Search: ${route.sources.join(', ')}`,
        `Read relevant sections: ${route.docs.join(', ')}`,
        `Focused check: ${route.check}`,
        'Search symbols with rg; read owning schemas/tests and any applicable nested AGENTS.md.',
        'These paths are navigation, not complete context or permission to skip delivery gates.',
      ].join('\n') + '\n';
  }
  if (Buffer.byteLength(output) > CONTEXT_POLICY.outputBytes)
    throw Error('Context navigation exceeds its output budget');
  return output;
}

export function inspectContext(root: string, paths: readonly string[]) {
  const findings: { path: string; reason: string }[] = [];
  const files: { path: string; bytes: number; limit: number }[] = [];
  const documents = [...new Set(paths)].filter((path) => /\.(?:md|mdx|markdown)$/i.test(path));
  if (!documents.length) throw Error('Documentation coverage is empty');
  const canonicalRoot = realpathSync(root);
  const safePath = (path: string) => {
    const file = resolve(root, path);
    const inside = relative(canonicalRoot, realpathSync(file));
    if (inside.startsWith('..') || lstatSync(file).isSymbolicLink())
      throw Error(`Documentation/navigation must stay inside the repository: ${path}`);
    return file;
  };
  const entrypoints: readonly string[] = CONTEXT_POLICY.entrypoints;
  const required = new Set([
    ...entrypoints,
    ...Object.values(CONTEXT_TOPICS).flatMap((route) => [...route.sources, ...route.docs]),
  ]);
  for (const path of required) {
    if (!existsSync(resolve(root, path))) findings.push({ path, reason: 'Missing context target' });
    else safePath(path);
    if (/\.md$/i.test(path) && !documents.includes(path))
      findings.push({ path, reason: 'Required document is outside Git coverage' });
  }
  for (const topic of ['list', ...Object.keys(CONTEXT_TOPICS)]) contextPlan(topic);
  for (const path of documents) {
    // Git lists unstaged deletions too; incoming links and required targets still catch them.
    if (!existsSync(resolve(root, path))) continue;
    const stat = lstatSync(safePath(path));
    if (!stat.isFile()) throw Error(`Not a document file: ${path}`);
    const limit = /(?:^|\/)(?:AGENTS|CLAUDE|SKILL)\.md$/i.test(path)
      ? CONTEXT_POLICY.instructionBytes
      : CONTEXT_POLICY.documentBytes;
    files.push({ path, bytes: stat.size, limit });
    if (stat.size > limit) findings.push({ path, reason: `${stat.size} bytes exceeds ${limit}` });
  }
  const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const entrypointBytes = files
    .filter((file) => entrypoints.includes(file.path))
    .reduce((sum, file) => sum + file.bytes, 0);
  for (const [path, bytes, limit] of [
    ['all documentation', totalBytes, CONTEXT_POLICY.totalBytes],
    ['entrypoints', entrypointBytes, CONTEXT_POLICY.entrypointBytes],
  ] as const)
    if (bytes > limit) findings.push({ path, reason: `${bytes} bytes exceeds ${limit}` });
  // Avoid reading oversized input. Both full verification and docs-only CI use this audit.
  if (totalBytes <= CONTEXT_POLICY.totalBytes)
    for (const failure of missingLocalLinks(
      root,
      files.filter((f) => f.bytes <= f.limit).map((f) => f.path),
    ))
      findings.push({ path: failure, reason: 'Broken local inline link' });
  return { policy: CONTEXT_POLICY, totalBytes, entrypointBytes, files, findings };
}
