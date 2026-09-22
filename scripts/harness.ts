import { readFileSync } from 'node:fs';
import { assessReport, exitCode } from './harness/report.ts';
import { collectSource, SOURCE_REQUIREMENTS } from './harness/source.ts';

try {
  const [command, input, baseline, ...extra] = process.argv.slice(2);
  if (extra.length || !input || !['source', 'report'].includes(command ?? '')) {
    throw new Error('Usage: node scripts/harness.ts source <unique-run-id> [baseline-sha] | report <source-report.json>');
  }
  if (command === 'report' && baseline !== undefined) throw new Error('Unexpected argument');
  const report = command === 'source'
    ? await collectSource(process.cwd(), input, baseline ?? null)
    : assessReport(JSON.parse(readFileSync(input, 'utf8')) as unknown, SOURCE_REQUIREMENTS);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = exitCode(report.status);
} catch {
  console.error('Harness input or collection failed; evidence is incomplete. See .github/harness/README.md.');
  process.exitCode = 2;
}
