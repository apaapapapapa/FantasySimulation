import { expect, it } from 'vite-plus/test';
import { apiReplaySource } from './api-source.ts';
import { openReplaySession } from './replay-session.ts';
import type { WorkerRequest, WorkerResponse } from './worker-contract.ts';

class FakeWorker extends EventTarget {
  sent: WorkerRequest[] = [];
  terminated = false;
  postMessage(value: WorkerRequest) {
    this.sent.push(value);
  }
  terminate() {
    this.terminated = true;
  }
  reply(value: WorkerResponse) {
    this.dispatchEvent(new MessageEvent('message', { data: value }));
  }
}
async function session() {
  const worker = new FakeWorker(),
    lifetime = new AbortController();
  const opening = openReplaySession(
    apiReplaySource('fixture-replay'),
    lifetime.signal,
    () => worker,
  );
  expect(worker.sent[0]).toMatchObject({
    action: 'open',
    location: { mode: 'api', id: 'fixture-replay' },
  });
  worker.reply({ id: worker.sent[0]!.id, ok: true, value: { manifest: {}, context: {} } });
  return { worker, lifetime, player: await opening };
}
it('rejects an aborted seek immediately and ignores its late reply while delivering the newest request', async () => {
  const { worker, lifetime, player } = await session();
  const obsolete = new AbortController();
  const first = player.frame(100, obsolete.signal);
  const rejected = expect(first).rejects.toMatchObject({ kind: 'aborted' });
  const firstId = worker.sent.at(-1)!.id;
  const latest = player.frame(200);
  const lastId = worker.sent.at(-1)!.id;
  obsolete.abort();
  await rejected;
  expect(worker.sent.at(-1)).toEqual({ id: firstId, action: 'cancel' });
  worker.reply({ id: firstId, ok: true, value: { checkpoint: { step: 100 } } });
  worker.reply({ id: lastId, ok: true, value: { checkpoint: { step: 200 } } });
  expect(await latest).toEqual({ checkpoint: { step: 200 } });
  lifetime.abort();
  expect(worker.terminated).toBe(true);
});
it('terminates the worker and rejects pending loads on navigation or crash', async () => {
  for (const reason of ['navigation', 'crash']) {
    const { worker, lifetime, player } = await session();
    const pending = player.events(0);
    const rejected = expect(pending).rejects.toMatchObject({
      kind: reason === 'navigation' ? 'aborted' : 'unavailable',
    });
    if (reason === 'navigation') lifetime.abort();
    else worker.dispatchEvent(new Event('error'));
    await rejected;
    expect(worker.terminated).toBe(true);
    await expect(player.frame(0)).rejects.toMatchObject({ kind: 'aborted' });
  }
});
it('preserves supported-format and delivery error categories across the worker boundary', async () => {
  const { worker, lifetime, player } = await session();
  for (const kind of ['unsupported', 'limit', 'damaged', 'unavailable'] as const) {
    const pending = player.frame(0);
    worker.reply({ id: worker.sent.at(-1)!.id, ok: false, kind, message: 'fixture error' });
    await expect(pending).rejects.toMatchObject({ kind, message: 'fixture error' });
  }
  lifetime.abort();
});
