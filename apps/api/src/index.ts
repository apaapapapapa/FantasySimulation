import { createApp } from './app.ts';
import { readConfig } from './config.ts';
import { openStore, readSampleRevisions } from './store.ts';
import { BattleService } from './battle-service.ts';

const config = readConfig();
const store = openStore(config.databasePath);
await store.seedRevisions(readSampleRevisions());
const runtime = await BattleService.open(store, config.artifactPath, config.runtime);
const app = createApp(store, true, runtime);

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
