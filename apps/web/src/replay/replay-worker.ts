import { apiReplaySource } from './api-source.ts';
import { publicLibrary } from './public-source.ts';
import { openReplay } from './open-replay.ts';
import { ReplayPlayer } from './replay-player.ts';
import { toLoadError } from './artifacts.ts';
import type { WorkerRequest, WorkerResponse } from './worker-contract.ts';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(response: WorkerResponse): void;
};
const requests = new Map<number, AbortController>();
let player: ReplayPlayer | undefined;
scope.onmessage = ({ data }) => {
  if (data.action === 'cancel') {
    requests.get(data.id)?.abort();
    return;
  }
  const controller = new AbortController();
  requests.set(data.id, controller);
  void (async () => {
    const signal = controller.signal;
    let value: unknown;
    if (data.action === 'open') {
      const location = data.location;
      const source =
        location.mode === 'api'
          ? apiReplaySource(location.id, { base: location.base })
          : publicLibrary(location.root).source(location.row);
      const replay = await openReplay(source, { signal });
      if (replay.manifest.end.kind === 'result') player = new ReplayPlayer(replay);
      value = { manifest: replay.manifest, context: replay.context };
    } else {
      if (!player) throw new Error('Replay is not playable');
      if (data.action === 'frame') value = await player.frame(data.index, signal);
      else if (data.action === 'events') value = await player.events(data.index, signal);
      else throw new Error('Unsupported replay worker operation');
    }
    signal.throwIfAborted();
    scope.postMessage({ id: data.id, ok: true, value });
  })()
    .catch((error: unknown) => {
      const failure = toLoadError(error, 'damaged', controller.signal);
      scope.postMessage({ id: data.id, ok: false, kind: failure.kind, message: failure.message });
    })
    .finally(() => requests.delete(data.id));
};
