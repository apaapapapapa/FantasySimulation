import { join } from 'node:path';
import { expect, it } from 'vite-plus/test';
import { catalogManifest } from '@fantasy/samples';
import { runBattle } from '@fantasy/engine/spatial';
import { withRuntime, specInput } from '../../test-support/runtime.ts';
import { readReplayChunk, seekReplay, verifyReplay } from '../replay/replay-reader.ts';

it('persists returned projectile ownership through a Worker SQLite and bidirectional replay seek', async () => {
  await withRuntime(
    async ({ runtime, store, jobs, root }) => {
      const input = await catalogManifest(
        'mirror-shooter-v1',
        'mirror-guard-v1',
        'flat-surveyed-v1',
        160,
      );
      await store.loadPinnedRevisions(input.revisions);
      const done = await runtime.wait(
        (await runtime.submit(specInput(input), 'p6-deflection', 'one')).id,
      );
      expect(done.state, JSON.stringify(done)).toBe('completed');
      const row = jobs.result(done.resultId!)!;
      const verified = await verifyReplay(root, row.replayId);
      const direct = await runBattle(verified.manifest.input);
      expect(JSON.parse(row.resultJson)).toEqual(direct.result);
      const records = [];
      for (const [index] of verified.manifest.chunks.entries())
        records.push(
          ...(await readReplayChunk(join(root, row.replayId), verified.manifest, index)),
        );
      expect(records).toEqual(direct.records);
      const index = direct.records.findIndex(
        (r) => r.kind === 'interval' && r.projectiles.update.some((p) => p.deflection),
      );
      expect(index).toBeGreaterThan(0);
      for (const cursor of [index + 1, index, index + 1]) {
        const replay = await seekReplay(root, row.replayId, cursor);
        const returned = replay.state!.projectiles.filter((p) => p.deflection);
        expect(returned.length).toBe(cursor > index ? 1 : 0);
        if (returned.length)
          expect(returned[0]).toMatchObject({
            ownerId: 'right',
            deflection: { originalOwnerId: 'left', ownerId: 'right' },
          });
      }
    },
    { workers: 1 },
    160,
  );
}, 30000);
