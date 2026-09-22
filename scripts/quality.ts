import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { architecture } from './quality/architecture.ts';
import {
  firstPartyJavaScript,
  unsupportedTypeScriptModules,
  qualityPaths,
  firstPartyTypeScript,
} from './quality/files.ts';
import { withSources } from './quality/ast.ts';
import { duplication, DUPLICATION_POLICY } from './quality/duplication.ts';
import { determinism } from './quality/determinism.ts';
import { assessReport } from './harness/report.ts';
import type { Check, Report } from './harness/report.ts';
import { sourceIdentity } from './harness/source.ts';

const required = [
  'quality:typescript',
  'quality:architecture',
  'quality:determinism',
  'quality:duplication',
  'quality:migrations',
];
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
  const paths = qualityPaths(root);
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
    [...firstPartyJavaScript(paths), ...unsupportedTypeScriptModules(paths)].map((path) => ({
      path,
      correction:
        'Use strict .ts/.tsx source; .mts/.cts module variants are unsupported by this workspace guard.',
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
  await run('quality:duplication', () => {
    details.duplicationCoverage = {
      policy: DUPLICATION_POLICY,
      selectedFiles: firstPartyTypeScript(paths),
    };
    return duplication(root, paths);
  });
  await run('quality:migrations', () => {
    const result = spawnSync(process.execPath, ['node_modules/drizzle-kit/bin.cjs', 'check'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, DATABASE_PATH: resolve(root, '.generated/drizzle-check.sqlite') },
    });
    if (result.error) throw result.error;
    return result.status === 0
      ? []
      : [
          {
            path: 'db/drizzle',
            reason: result.stderr || result.stdout || `Drizzle Kit exited ${String(result.status)}`,
            correction: 'Resolve the Drizzle Kit history conflict; never rewrite applied SQL.',
          },
        ];
  });
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
