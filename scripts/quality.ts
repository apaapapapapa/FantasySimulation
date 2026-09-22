import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { architecture } from './quality/architecture.ts';
import { firstPartyJavaScript } from './quality/files.ts';
import { withSources } from './quality/ast.ts';
import { determinism } from './quality/determinism.ts';
import { assessReport } from './harness/report.ts';
import type { Check, Report } from './harness/report.ts';
import { sourceIdentity } from './harness/source.ts';

const required = ['quality:typescript', 'quality:architecture', 'quality:determinism'];
const startedAt = new Date().toISOString();
const checks: Check[] = [];
const details: Record<string, unknown> = {};
try {
  if (process.argv.length !== 2) throw Error('Usage: node scripts/quality.ts');
  const root = process.cwd();
  const info = sourceIdentity(root);
  const directory = '.generated/harness/quality';
  mkdirSync(directory, { recursive: true });
  const evidence = [{ uri: `${directory}/findings.json`, sourceSha: info.sourceSha }];
  const paths = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
  if (!paths.length) throw Error('Tracked source coverage is empty');
  const run = async (id: string, collect: () => Promise<unknown[]> | unknown[]) => {
    try {
      const findings = await collect();
      details[id] = findings;
      checks.push({
        id,
        required: true,
        status: findings.length ? 'fail' : 'pass',
        reason: `${findings.length} violations; see findings for source, destination and correction`,
        evidence,
      });
      for (const finding of findings) console.error(`${id}: ${JSON.stringify(finding)}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Guard did not complete';
      details[id] = { error: reason };
      checks.push({ id, required: true, status: 'unknown', reason, evidence });
      console.error(`${id}: ${reason}`);
    }
  };
  await run('quality:typescript', () =>
    firstPartyJavaScript(paths).map((path) => ({
      path,
      correction: 'Use strict TypeScript for first-party source and configuration.',
    })),
  );
  await run('quality:architecture', async () => {
    const graph = await architecture(root, paths);
    return [...graph.publicGraph.summary.violations, ...graph.runtimeGraph.summary.violations];
  });
  await run('quality:determinism', () =>
    withSources(
      root,
      paths.filter(
        (path) =>
          /^packages\/engine\/src\/.*\.tsx?$/.test(path) && !/\.(?:test|d)\.tsx?$/.test(path),
      ),
      (files, _options, checker) =>
        [...files].flatMap(([path, file]) => determinism(path, file, checker)),
    ),
  );
  writeFileSync(`${directory}/findings.json`, JSON.stringify({ ...info, details }, null, 2) + '\n');
  const report: Report = {
    ...info,
    schemaVersion: 1,
    producer: 'quality-runner',
    startedAt,
    finishedAt: new Date().toISOString(),
    checks,
  };
  const result = assessReport(report, required);
  writeFileSync(`${directory}/report.json`, JSON.stringify(result.report, null, 2) + '\n');
  console.log(`FANTASY_QUALITY_REPORT=${JSON.stringify(result.report)}`);
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Quality evidence incomplete');
  process.exitCode = 2;
}
