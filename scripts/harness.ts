import { readFileSync } from 'node:fs';
import { assessReport } from './harness/report.ts';
import { collectSource } from './harness/source.ts';
import { completeIssues, completionDraft } from './harness/issue-completion-api.ts';

try {
  const [command, input, ...required] = process.argv.slice(2);
  if (!input)
    throw new Error(
      'Usage: harness source <fresh-output> | report <file> <required-check>... | issue-plan <number> | issue-complete <evidence-directory> [--apply]',
    );
  let result;
  if (command === 'source' && required.length === 0)
    result = await collectSource(process.cwd(), input);
  else if (command === 'issue-plan' && required.length === 0)
    result = { report: await completionDraft(Number(input)), exitCode: 0 };
  else if (
    command === 'issue-complete' &&
    (required.length === 0 || (required.length === 1 && required[0] === '--apply'))
  )
    result = await completeIssues(input, required[0] === '--apply');
  else if (command === 'report') {
    const data = readFileSync(input);
    if (data.length > 8 * 1024 * 1024) throw new Error('Report exceeds size budget');
    result = assessReport(JSON.parse(data.toString('utf8')) as unknown, required);
  } else throw new Error('Unknown command or unexpected arguments');
  console.log(JSON.stringify(result.report, null, 2));
  if (command === 'source') console.log(`FANTASY_SOURCE_REPORT=${JSON.stringify(result.report)}`);
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid harness input');
  process.exitCode = 2;
}
