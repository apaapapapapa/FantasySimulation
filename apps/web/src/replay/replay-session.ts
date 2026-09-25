import { ReplayLoadError } from './artifacts.ts';
import type { ReplaySource } from './open-replay.ts';
import type {
  ReplayControls,
  ReplayInfo,
  WorkerRequest,
  WorkerResponse,
} from './worker-contract.ts';

export type ReplaySession = ReplayInfo & ReplayControls;
type Port = Pick<Worker, 'postMessage' | 'addEventListener' | 'removeEventListener' | 'terminate'>;

/** One worker per mounted replay. Only a small verified frame crosses into React. */
export async function openReplaySession(
  source: ReplaySource,
  signal: AbortSignal,
  create: () => Port = () =>
    new Worker(new URL('./replay-worker.ts', import.meta.url), { type: 'module' }),
): Promise<ReplaySession> {
  signal.throwIfAborted();
  if (!source.location) throw new ReplayLoadError('unavailable', 'Replay worker source is missing');
  const worker = create();
  let next = 0,
    closed = false;
  const pending = new Map<
    number,
    { settle(response: WorkerResponse): void; reject(error: unknown): void }
  >();
  const receive = (event: MessageEvent<WorkerResponse>) =>
    pending.get(event.data.id)?.settle(event.data);
  const close = (error: unknown) => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', aborted);
    worker.removeEventListener('message', receive);
    worker.removeEventListener('error', crashed);
    worker.removeEventListener('messageerror', crashed);
    worker.terminate();
    for (const request of [...pending.values()]) request.reject(error);
  };
  const aborted = () => close(new ReplayLoadError('aborted', 'Replay loading was cancelled'));
  const crashed = () => close(new ReplayLoadError('unavailable', 'Replay worker failed'));
  worker.addEventListener('message', receive);
  worker.addEventListener('error', crashed);
  worker.addEventListener('messageerror', crashed);
  signal.addEventListener('abort', aborted, { once: true });
  function request<T>(message: WorkerRequest, requestSignal?: AbortSignal): Promise<T> {
    if (closed || requestSignal?.aborted)
      return Promise.reject(new ReplayLoadError('aborted', 'Replay loading was cancelled'));
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        pending.delete(message.id);
        requestSignal?.removeEventListener('abort', cancel);
      };
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const cancel = () => {
        worker.postMessage({ id: message.id, action: 'cancel' } satisfies WorkerRequest);
        fail(new ReplayLoadError('aborted', 'Replay loading was cancelled'));
      };
      pending.set(message.id, {
        settle(response) {
          cleanup();
          if (response.ok) resolve(response.value as T);
          else reject(new ReplayLoadError(response.kind, response.message));
        },
        reject: fail,
      });
      requestSignal?.addEventListener('abort', cancel, { once: true });
      try {
        worker.postMessage(message);
      } catch (error) {
        fail(error);
      }
    });
  }
  try {
    const info = await request<ReplayInfo>({
      id: ++next,
      action: 'open',
      location: source.location,
    });
    signal.throwIfAborted();
    return {
      ...info,
      frame: (index, signal) => request({ id: ++next, action: 'frame', index }, signal),
      events: (index, signal) => request({ id: ++next, action: 'events', index }, signal),
    };
  } catch (error) {
    close(error);
    throw error;
  }
}
