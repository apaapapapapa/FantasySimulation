import { resolve } from 'node:path';
import { resetDevelopmentDatabase } from './migrations.ts';
import { DEFAULT_RULESET } from '@fantasy/engine';
import { readConfig, repositoryRoot } from './config.ts';
import { openStore, readSampleCharacters } from './store.ts';

const command = process.argv[2];
if (command === 'reset') {
  const [filename, flag, confirmation, ...extra] = process.argv.slice(3);
  if (!filename || flag !== '--confirm-generation' || !confirmation || extra.length)
    throw Error('Usage: db:reset <new-file> --confirm-generation <generation>');
  const target = resolve(repositoryRoot, filename);
  resetDevelopmentDatabase(target, confirmation);
  console.log(`New development database ready: ${target}. Set DATABASE_PATH to use it.`);
} else {
  if (command !== 'migrate' && command !== 'seed') throw new Error('Expected migrate or seed.');
  const config = readConfig();
  const store = openStore(config.databasePath);
  try {
    store.registerRuleset(DEFAULT_RULESET);
    if (command === 'seed') store.seedCharacters(readSampleCharacters());
    console.log(`Database ${command} completed: ${config.databasePath}`);
  } finally {
    store.close();
  }
}
