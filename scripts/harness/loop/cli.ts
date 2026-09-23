import { readBoundedJson } from '../files.ts';
import { initialize, readJournal } from './journal.ts';
import { status } from './state.ts';

export async function loopCommand(args: string[]) {
  const [command, path, input, ...extra] = args;
  if (!path || extra.length) throw new Error('Invalid loop arguments');
  if (command === 'init' && input) {
    const journal = initialize(path, readBoundedJson(input));
    const view = status(readJournal(journal));
    return {
      journal,
      operationRecorded: true,
      repairComplete: view.phase === 'completed',
      ...view,
    };
  }
  if (command === 'status' && !input) {
    const view = status(readJournal(path));
    return { ...view, repairComplete: view.phase === 'completed', processLiveness: 'not-observed' };
  }
  throw new Error('Supported: loop init <store> <contract.json> | loop status <journal.json>');
}
