import { rm } from 'node:fs/promises';
import { canonicalJson, type ReplayManifest } from '@fantasy/domain/spatial';
import { JobStore, type StoredArtifact } from './job-store.ts';
import { replayDirectory, sha256 } from './replay-files.ts';
import { readReplayManifest, verifyReplayDirectory } from './replay-reader.ts';
import { StoreError } from './store.ts';

export class ArtifactStore {
  constructor(
    readonly jobs: JobStore,
    readonly root: string,
  ) {}
  metadata(manifest: ReplayManifest): StoredArtifact {
    const text = canonicalJson(manifest);
    return {
      id: manifest.id,
      attemptId: manifest.attemptId,
      state: 'ready',
      createdAt: Date.now(),
      manifestChecksum: sha256(text),
      bytes:
        Buffer.byteLength(text) +
        [...manifest.chunks, ...manifest.checkpoints].reduce((n, r) => n + r.bytes, 0),
    };
  }
  async verified(id: string) {
    const artifact = this.jobs.artifact(id);
    if (!artifact) throw new StoreError(404, 'Replay not found');
    if (artifact.state !== 'ready')
      throw new StoreError(503, `Replay is ${artifact.state}; result held`);
    try {
      const manifest = await readReplayManifest(this.root, id, artifact.manifestChecksum);
      await verifyReplayDirectory(replayDirectory(this.root, id), manifest);
      if (
        manifest.attemptId !== artifact.attemptId ||
        this.metadata(manifest).bytes !== artifact.bytes
      )
        throw new Error('Replay reference binding mismatch');
      return manifest;
    } catch (error) {
      const state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt';
      this.jobs.markArtifact(id, state);
      throw new StoreError(503, `Replay is ${state}; result held`);
    }
  }
  async discard(id: string) {
    // Never remove a reference that won completion/cancellation ordering.
    if (!this.jobs.artifact(id))
      await rm(replayDirectory(this.root, id), { recursive: true, force: true });
  }
}
