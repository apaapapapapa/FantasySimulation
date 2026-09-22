import { readConfig } from './config.ts';
import { openStore, readSampleRevisions } from './store.ts';

if (process.argv.length !== 2) throw new Error('Usage: db:seed');
const config = readConfig();
const store = openStore(config.databasePath);
try {
  await store.seedRevisions(readSampleRevisions());
  console.log(`Missing sample revisions inserted: ${config.databasePath}`);
} finally {
  store.close();
}
