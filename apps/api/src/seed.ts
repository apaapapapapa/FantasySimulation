import { readConfig } from './config.ts';
import { openStore } from './db/store.ts';
import { seedStartupData } from './db/startup-data.ts';

if (process.argv.length !== 2) throw new Error('Usage: db:seed');
const config = readConfig();
const store = openStore(config.databasePath);
try {
  const seeded = await seedStartupData(store);
  console.log(
    `Missing sample revisions and skill catalog ${seeded.skillCatalog.reference.id}@${seeded.skillCatalog.reference.revision} inserted: ${config.databasePath}`,
  );
} finally {
  store.close();
}
