import { join } from 'node:path';
import { startWeb } from './web-server.ts';
import { createApp } from '@fantasy/api/local';
import { openStore, readSampleRevisions } from '@fantasy/api/local';
import { BattleService } from '@fantasy/api/local';
import { readConfig } from '@fantasy/api/local';
import { RevisionSchema } from '@fantasy/domain/spatial';

/** Ports are assigned by bind(0), never probed/released or reused from another server. */
export interface ServerState {
  apiOrigin: string | null;
  webOrigin: string | null;
  stopped: boolean;
}
export async function startServers(
  root: string,
  temporary: string,
  observe: (state: ServerState) => void = () => {},
) {
  const store = openStore(join(temporary, 'sample.sqlite'));
  const state: ServerState = { apiOrigin: null, webOrigin: null, stopped: false };
  const close: (() => Promise<unknown>)[] = [];
  const stop = async () => {
    const outcomes = await Promise.allSettled(close.toReversed().map((dispose) => dispose()));
    if (outcomes.some((outcome) => outcome.status === 'rejected'))
      throw new Error('Server cleanup failed');
    state.stopped = true;
    observe({ ...state });
  };
  close.push(async () => store.close());
  try {
    const samples = readSampleRevisions().map((value) => RevisionSchema.parse(value));
    await store.seedRevisions(samples);
    const runtime = await BattleService.open(
      store,
      join(temporary, 'replays'),
      readConfig().runtime,
    );
    close.push(() => runtime.close());
    const api = createApp(store, false, runtime);
    // The app owns store/runtime after this point, matching the production lifecycle.
    close.splice(0, close.length, () => api.close());
    const apiOrigin = await api.listen({ host: '127.0.0.1', port: 0 });
    state.apiOrigin = apiOrigin;
    observe({ ...state });
    const web = await startWeb(root, temporary, { apiOrigin });
    close.push(() => web.close());
    const address = web.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Web server did not bind');
    const webOrigin = `http://127.0.0.1:${address.port}`;
    state.webOrigin = webOrigin;
    observe({ ...state });
    // Both must be ready before starting a browser; these are owned, already bound origins.
    for (const url of [`${apiOrigin}/api/health`, webOrigin]) {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Isolated server readiness failed');
      await response.arrayBuffer();
    }
    return {
      webOrigin,
      apiOrigin,
      stop,
      samples: samples.map(({ id, revision, contentHash, kind }) => ({
        id,
        revision,
        contentHash,
        kind,
      })),
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
