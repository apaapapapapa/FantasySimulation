import { createApp } from './app.ts';
import { readConfig } from './config.ts';
import { openStore, readSampleCharacters } from './store.ts';

const config = readConfig();
const store = openStore(config.databasePath);
store.seedCharacters(readSampleCharacters());
const app = createApp(store, true);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch((error: unknown) => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
