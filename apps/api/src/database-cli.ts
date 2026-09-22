import { DEFAULT_RULESET } from '@fantasy/engine';
import { readConfig } from './config.ts';
import { openStore, readSampleCharacters } from './store.ts';

const command = process.argv[2];
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
