import { createApp } from './app.ts';
import { readConfig } from './config.ts';
import { openStore, readSampleRevisions } from './store.ts';
import { BattleRuntime } from './battle-runtime.ts';
import { assertStoragePaths } from './storage-version.ts';

const config = readConfig();
await assertStoragePaths(config.databasePath, config.artifactPath);
const store = openStore(config.databasePath);
await store.seedRevisions(readSampleRevisions());
const runtime = await BattleRuntime.open(store, config.artifactPath, config.runtime);
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
