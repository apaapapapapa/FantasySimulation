import { describe, expect, it, vi } from 'vite-plus/test';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import { ReplayState, canonicalJson, type ReplayManifest } from '@fantasy/domain/spatial';
import { withRuntime } from '../../test-support/runtime.ts';
import { recordedBattle, withReplayDirectory } from '../../test-support/replays.ts';
import { BattleService } from '../jobs/battle-service.ts';
import { ArtifactStore } from './artifact-store.ts';
import { replayArtifacts } from '../db/schema.ts';
import {
  readReplayManifest,
  replayValidationProfile,
  REPLAY_VALIDATION_PROFILE,
  verifyReplayDirectory,
} from './replay-reader.ts';
import { readCompressed, sha256 } from './replay-files.ts';

type Fixture = Parameters<Parameters<typeof withRuntime>[0]>[0];
async function withArtifact(
  work: (fixture: Omit<Fixture, 'manifest'> & { manifest: ReplayManifest }) => Promise<void>,
) {
  await withRuntime(async (fixture) => {
    const job = await fixture.runtime.wait(
      (await fixture.runtime.submit(fixture.spec, 'attestation', 'one')).id,
    );
    const row = fixture.jobs.result(job.resultId!)!;
    const manifest = await readReplayManifest(fixture.root, row.replayId);
    await work({ ...fixture, manifest });
  });
}
describe('checksum reuse of semantically verified replay bytes', { timeout: 30_000 }, () => {
  it('reuses a writer attestation after coordinator restart without replaying records', async () => {
    await withArtifact(async ({ runtime, jobs, store, root, manifest }) => {
      expect(jobs.artifact(manifest.id)?.validationProfile).toBe(REPLAY_VALIDATION_PROFILE);
      await runtime.close();
      const reopened = await BattleService.open(store, root);
      const apply = vi.spyOn(ReplayState.prototype, 'apply');
      try {
        expect(await reopened.replay(manifest.id)).toEqual(manifest);
        expect((await reopened.result(manifest.resultId!)).replayId).toBe(manifest.id);
        expect(apply).not.toHaveBeenCalled();
      } finally {
        apply.mockRestore();
        await reopened.close();
      }
    });
  });
  it.each([null, 'unrecognized-profile'])(
    'fully validates %s receipts once before adoption',
    async (profile) => {
      await withArtifact(async ({ runtime, jobs, store, manifest }) => {
        store.orm
          .update(replayArtifacts)
          .set({ validationProfile: profile })
          .where(eq(replayArtifacts.id, manifest.id))
          .run();
        const before = jobs.artifact(manifest.id)!;
        const apply = vi.spyOn(ReplayState.prototype, 'apply');
        try {
          await runtime.replay(manifest.id);
          expect(apply).toHaveBeenCalledTimes(manifest.records);
          expect(jobs.artifact(manifest.id)).toEqual({
            ...before,
            validationProfile: REPLAY_VALIDATION_PROFILE,
          });
          apply.mockClear();
          await runtime.replay(manifest.id);
          expect(apply).not.toHaveBeenCalled();
        } finally {
          apply.mockRestore();
        }
      });
    },
  );
  it('never treats a copied or mutated manifest as a writer-issued attestation', async () => {
    await withReplayDirectory(async (root) => {
      const { manifest } = await recordedBattle(root, 20);
      expect(replayValidationProfile(manifest)).toBe(REPLAY_VALIDATION_PROFILE);
      expect(replayValidationProfile(structuredClone(manifest))).toBeNull();
      manifest.resultId = 'changed-result';
      expect(replayValidationProfile(manifest)).toBeNull();
    });
  });
  it.each(['missing', 'corrupt', 'manifest', 'binding'] as const)(
    'holds %s data even with a persisted attestation',
    async (damage) => {
      await withArtifact(async ({ runtime, jobs, store, root, manifest }) => {
        const file = join(root, manifest.id, manifest.chunks[0]!.file);
        if (damage === 'missing') await rm(file);
        else if (damage === 'corrupt') await writeFile(file, 'broken');
        else if (damage === 'manifest')
          await writeFile(join(root, manifest.id, 'manifest.json'), '{}');
        else
          store.orm
            .update(replayArtifacts)
            .set({ bytes: jobs.artifact(manifest.id)!.bytes + 1 })
            .where(eq(replayArtifacts.id, manifest.id))
            .run();
        await expect(runtime.replay(manifest.id)).rejects.toThrow(/held/);
        expect(jobs.artifact(manifest.id)?.state).toBe(
          damage === 'missing' ? 'missing' : 'corrupt',
        );
        await expect(runtime.result(manifest.resultId!)).rejects.toThrow(/held/);
      });
    },
  );
  it('rejects semantically invalid legacy content with recomputed valid file checksums', async () => {
    await withArtifact(async ({ runtime, jobs, store, root, manifest }) => {
      const checkpoint = manifest.checkpoints[0]!,
        directory = join(root, manifest.id);
      const value = JSON.parse(await readCompressed(directory, checkpoint));
      value.nextRecord++;
      const raw = canonicalJson(value),
        bytes = gzipSync(raw);
      await writeFile(join(directory, checkpoint.file), bytes);
      Object.assign(checkpoint, {
        bytes: bytes.length,
        rawBytes: Buffer.byteLength(raw),
        checksum: sha256(bytes),
      });
      await expect(verifyReplayDirectory(directory, manifest)).rejects.toMatchObject({
        code: 'DATA_INVALID',
        message: 'Checkpoint does not match the verified prefix',
      });
      await writeFile(join(directory, 'manifest.json'), canonicalJson(manifest));
      const metadata = new ArtifactStore(jobs, root).metadata(manifest);
      expect(metadata.validationProfile).toBeNull();
      store.orm
        .update(replayArtifacts)
        .set({
          manifestChecksum: metadata.manifestChecksum,
          bytes: metadata.bytes,
          validationProfile: null,
        })
        .where(eq(replayArtifacts.id, manifest.id))
        .run();
      await expect(runtime.replay(manifest.id)).rejects.toThrow(/corrupt/);
      expect(jobs.artifact(manifest.id)?.validationProfile).toBeNull();
    });
  });
});
