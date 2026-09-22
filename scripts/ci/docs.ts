import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { assessReport } from '../harness/report.ts';
import type { Report } from '../harness/report.ts';
import { parsePlan } from './plan.ts';
// Wording check, not a Markdown renderer: local inline links, not remote URLs/anchors.
export function missingLocalLinks(root: string, paths: readonly string[]): string[] {
  const failures: string[] = [];
  for (const path of paths) {
    const file = resolve(root, path);
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8').replace(/```[^]*?```/g, '');
    for (const match of content.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const link = match[1]!;
      if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(link)) continue;
      const target = decodeURIComponent(link.split(/[?#]/)[0] ?? '');
      if (!target) continue;
      const absolute = resolve(dirname(file), target),
        inside = relative(root, absolute);
      if (inside.startsWith('..') || !existsSync(absolute)) failures.push(`${path}: ${target}`);
    }
  }
  return failures;
}
export function verifyDocs(root: string) {
  const plan = parsePlan(
    JSON.parse(readFileSync('.generated/harness/ci/plan.json', 'utf8')) as unknown,
  );
  if (plan.full || !plan.baselineSha || process.env.GITHUB_SHA !== plan.sourceSha)
    throw new Error('Docs shortcut is not authorized by this source plan');
  const at = new Date().toISOString(),
    failures = missingLocalLinks(root, plan.paths);
  let clean = true;
  try {
    execFileSync('git', ['diff', '--check', plan.baselineSha, plan.sourceSha, '--'], {
      cwd: root,
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch {
    clean = false;
  }
  mkdirSync('.generated/harness/docs', { recursive: true });
  const details = '.generated/harness/docs/links.json';
  writeFileSync(
    details,
    JSON.stringify({ sourceSha: plan.sourceSha, failures, checkedPaths: plan.paths }, null, 2) +
      '\n',
  );
  const evidence = [{ uri: details, sourceSha: plan.sourceSha }];
  const report: Report = {
    ...plan,
    schemaVersion: 1,
    producer: 'docs-check',
    startedAt: at,
    finishedAt: new Date().toISOString(),
    checks: [
      {
        id: 'docs:diff',
        required: true,
        status: clean ? 'pass' : 'fail',
        reason: 'git diff --check against tested base',
        evidence,
      },
      {
        id: 'docs:links',
        required: true,
        status: failures.length ? 'fail' : 'pass',
        reason: `Local inline-link failures: ${failures.length}`,
        evidence,
      },
    ],
  };
  const result = assessReport(report, ['docs:diff', 'docs:links']);
  writeFileSync(
    '.generated/harness/docs/report.json',
    JSON.stringify(result.report, null, 2) + '\n',
  );
  return result;
}
if (process.argv[1]?.endsWith('/ci/docs.ts') || process.argv[1]?.endsWith('\\ci\\docs.ts')) {
  try {
    process.exitCode = verifyDocs(process.cwd()).exitCode;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Docs check failed');
    process.exitCode = 2;
  }
}
