import { startStaticFixtures } from './static-fixtures.ts';
import { startWeb } from './web-server.ts';

export interface StaticState {
  apiOrigin: null;
  dataOrigin: string | null;
  webOrigin: string | null;
  stopped: boolean;
}
export async function startStaticServers(
  root: string,
  temporary: string,
  observe: (state: StaticState) => void,
) {
  const state: StaticState = { apiOrigin: null, dataOrigin: null, webOrigin: null, stopped: false };
  const close: (() => Promise<unknown>)[] = [];
  const stop = async () => {
    const outcomes = await Promise.allSettled(close.toReversed().map((dispose) => dispose()));
    if (outcomes.some((result) => result.status === 'rejected'))
      throw new Error('Static cleanup failed');
    state.stopped = true;
    observe({ ...state });
  };
  try {
    const data = await startStaticFixtures(root, () => state.webOrigin);
    close.push(data.stop);
    state.dataOrigin = data.origin;
    observe({ ...state });
    const web = await startWeb(root, temporary, { dataOrigin: data.origin });
    close.push(() => web.close());
    const address = web.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Static web did not bind');
    state.webOrigin = `http://127.0.0.1:${address.port}`;
    observe({ ...state });
    for (const url of [
      `${data.origin}/fixtures/catalog/current.json`,
      `${state.webOrigin}/FantasySimulation/`,
    ]) {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('Static readiness failed');
      await response.arrayBuffer();
    }
    return {
      webOrigin: state.webOrigin,
      dataOrigin: data.origin,
      apiOrigin: null,
      samples: [],
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
