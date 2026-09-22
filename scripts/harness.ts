import { readJson, repositoryRoot } from './harness/artifacts.ts';
import { assessReport } from './harness/report.ts';
import { collectSource } from './harness/source.ts';
try {
  const [command,path,baseline,...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected arguments');
  if (command === 'report' && path && baseline === undefined) {
    const result = assessReport(readJson(path));
    console.log(JSON.stringify(result,null,2));
    process.exitCode = result.exitCode;
  } else if (command === 'source' && path) {
    const result = await collectSource(repositoryRoot(),path,baseline ?? null);
    console.log(JSON.stringify(result,null,2));
    process.exitCode = result.exitCode;
  } else { throw new Error('Usage: node scripts/harness.ts report <report.json> | source <.generated/fresh-path> [baseline-sha]'); }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Harness input or collection failed');
  process.exitCode = 2;
}
