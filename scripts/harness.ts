import { readBoundedJson } from './harness/files.ts';
import { assessReport } from './harness/report.ts';
import { collectSource } from './harness/source.ts';

const json = (path: string) => readBoundedJson(path, 32 * 1024 * 1024);

try {
  const [command, input, ...args] = process.argv.slice(2);
  if (!input) throw new Error('Harness input is required');
  if (command === 'github-snapshot') {
    const [number, directory, ...extra] = args;
    if (!number || !/^[1-9]\d*$/.test(number) || !directory || extra.length)
      throw new Error('Invalid collection arguments');
    const { createGateway } = await import('./harness/github.ts');
    const { collectSnapshot, saveSnapshot } = await import('./harness/github-collect.ts');
    const { conversationDigest } = await import('./harness/delivery.ts');
    const snapshot = await collectSnapshot(
      createGateway(process.env.GH_TOKEN ?? ''),
      input,
      Number(number),
    );
    saveSnapshot(process.cwd(), directory, snapshot);
    console.log(
      JSON.stringify(
        {
          snapshot: `${directory}/github-snapshot.json`,
          conversationDigest: conversationDigest(snapshot),
          collectionErrors: snapshot.errors,
          deliveryAssessed: false,
        },
        null,
        2,
      ),
    );
    process.exitCode = snapshot.errors.length ? 2 : 0;
  } else {
    let result;
    if (command === 'source' && args.length === 0)
      result = await collectSource(process.cwd(), input);
    else if (command === 'report') result = assessReport(json(input), args);
    else if (command === 'delivery') {
      const [target, receipt, ...extra] = args;
      if ((target !== 'pr' && target !== 'merge') || extra.length)
        throw new Error('Invalid delivery arguments');
      const { assessDelivery } = await import('./harness/delivery.ts');
      result = assessDelivery(json(input), target, receipt ? json(receipt) : null);
    } else throw new Error('Unknown command or unexpected arguments');
    console.log(JSON.stringify(result.report, null, 2));
    if (command === 'source') console.log(`FANTASY_SOURCE_REPORT=${JSON.stringify(result.report)}`);
    process.exitCode = result.exitCode;
  }
} catch {
  console.error(
    'Harness input or collection failed; evidence is incomplete. See .github/harness/README.md.',
  );
  process.exitCode = 2;
}
