import { DEFAULT_RULESET } from '@fantasy/engine';
import { readConfig } from './config.ts';
import { openStore, readSampleCharacters } from './store.ts';

if (process.argv.length !== 2) throw new Error('Usage: db:seed');
const config = readConfig();
const store = openStore(config.databasePath);
try {
  store.registerRuleset(DEFAULT_RULESET);
  store.seedCharacters(readSampleCharacters());
  console.log(`Missing sample characters inserted: ${config.databasePath}`);
} finally {
  store.close();
}
