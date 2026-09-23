import { readBoundedJson } from './harness/files.ts';
import { assessReport } from './harness/report.ts';
import { collectSource } from './harness/source.ts';

const json = (path: string) => readBoundedJson(path, 32 * 1024 * 1024);

try {
  const [command, input, ...args] = process.argv.slice(2);
  if (!input) throw new Error('Harness input is required');
  if (command === 'context' && args.length === 0) {
    const { contextPlan, inspectContext } = await import('./harness/context.ts');
    if (input === 'check') {
      const { qualityPaths } = await import('./quality/files.ts');
      const { files, ...summary } = inspectContext(process.cwd(), qualityPaths(process.cwd()));
      console.log(JSON.stringify({ ...summary, documentCount: files.length }, null, 2));
      process.exitCode = summary.findings.length ? 1 : 0;
    } else process.stdout.write(contextPlan(input));
  } else if (command === 'github-snapshot') {
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
    else if (
      command === 'corpus' &&
      (args.length === 0 || (args.length === 2 && args[0] === '--tests'))
    ) {
      const { collectCorpus } = await import('./harness/corpus.ts');
      result = await collectCorpus(
        process.cwd(),
        input,
        args.length ? { testShards: Number(args[1]) } : {},
      );
    } else if (
      command === 'load' &&
      (args.length === 0 || (args.length === 2 && args[0] === '--shard'))
    ) {
      const { collectLoad } = await import('./harness/load.ts');
      result = await collectLoad(
        process.cwd(),
        ['current', 'verify'].includes(input) ? null : input,
        input === 'verify',
        args.length ? Number(args[1]) : null,
      );
    } else if (command === 'issue-plan' && args.length === 0) {
      const { completionDraft } = await import('./harness/issue-completion-api.ts');
      result = { report: await completionDraft(Number(input)), exitCode: 0 };
    } else if (
      command === 'issue-complete' &&
      (args.length === 0 || (args.length === 1 && args[0] === '--apply'))
    ) {
      const { completeIssues } = await import('./harness/issue-completion-api.ts');
      result = await completeIssues(input, args[0] === '--apply');
    } else if (command === 'report') result = assessReport(json(input), args);
    else if (command === 'delivery') {
      const [target, receipt, ...extra] = args;
      if ((target !== 'pr' && target !== 'merge') || extra.length)
        throw new Error('Invalid delivery arguments');
      const { assessDelivery } = await import('./harness/delivery.ts');
      result = assessDelivery(json(input), target, receipt ? json(receipt) : null);
    } else throw new Error('Unknown command or unexpected arguments');
    console.log(JSON.stringify(result.report, null, 2));
    if (command === 'source') console.log(`FANTASY_SOURCE_REPORT=${JSON.stringify(result.report)}`);
    if (command === 'corpus') console.log(`FANTASY_CORPUS_REPORT=${JSON.stringify(result.report)}`);
    process.exitCode = result.exitCode;
  }
} catch {
  console.error(
    'Harness input or collection failed; evidence is incomplete. See .github/harness/README.md.',
  );
  process.exitCode = 2;
}
