import { readFileSync } from 'node:fs';
import { assessReport } from './harness/report.ts';
import { collectSource } from './harness/source.ts';

try {
  const [command, input, ...required] = process.argv.slice(2);
  if (!input) throw new Error('Usage: harness source <fresh-output> | report <file> <required-check>...');
  let result;
  if (command === 'source' && required.length === 0)
    result = await collectSource(process.cwd(), input);
  else if (command === 'report') {
    const data = readFileSync(input);
    if (data.length > 8 * 1024 * 1024) throw new Error('Report exceeds size budget');
    result = assessReport(JSON.parse(data.toString('utf8')) as unknown, required);
  } else throw new Error('Unknown command or unexpected arguments');
  console.log(JSON.stringify(result.report, null, 2));
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid harness input');
  process.exitCode = 2;
}
