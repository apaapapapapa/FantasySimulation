import { readBoundedJson } from '../files.ts';
import { initialize, readJournal } from './journal.ts';
import { status } from './state.ts';
import { git } from '../source.ts';
import { controllerRoot } from './workspace.ts';

export async function loopCommand(args: string[]) {
  const [command, path, input, ...extra] = args;
  if (!path || extra.length) throw new Error('Invalid loop arguments');
  if (command === 'init' && input) {
    const journal = initialize(path, readBoundedJson(input));
    return {
      journal,
      operationRecorded: true,
      repairComplete: false,
      ...status(readJournal(journal)),
    };
  }
  if (command === 'status' && !input) {
    const view = status(readJournal(path));
    return { ...view, repairComplete: view.phase === 'completed', processLiveness: 'not-observed' };
  }
  if (git(controllerRoot, ['status', '--porcelain=v1', '--untracked-files=all']))
    throw new Error('Use a clean trusted controller checkout');
  const { prepare, beginAttempt, applyPatch, recover } = await import('./workspace.ts');
  if (command === 'prepare' && input) return prepare(path, input);
  if (command === 'begin' && input) return beginAttempt(path, readBoundedJson(input));
  if (command === 'apply' && input) return applyPatch(path, readBoundedJson(input));
  if (command === 'recover' && input) return recover(path, input);
  if (command === 'evaluate' && !input) {
    const { evaluate } = await import('./evaluation.ts');
    return evaluate(path);
  }
  if (command === 'regression' && input) {
    const { regression } = await import('./regression.ts');
    return regression(path, readBoundedJson(input));
  }
  const { review, handoff, observe } = await import('./handoff.ts');
  if (command === 'review' && input) return review(path, readBoundedJson(input));
  if (command === 'handoff' && !input) return handoff(path);
  if (command === 'observe' && input) return observe(path, readBoundedJson(input));
  throw new Error(
    'Supported: init, status, prepare, begin, apply, evaluate, recover, regression, review, handoff, observe',
  );
}
