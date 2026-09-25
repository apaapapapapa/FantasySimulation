import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, type ReplayManifest } from '@fantasy/domain/spatial';
import { JobStore, type StoredArtifact } from './job-store.ts';
import { readBoundedFile, replayDirectory, sha256 } from './replay-files.ts';
import {
  readReplayManifest,
  verifyReplayDirectory,
  verifyReplayChecksums,
  replayValidationProfile,
  REPLAY_VALIDATION_PROFILE,
} from './replay-reader.ts';
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
      validationProfile: replayValidationProfile(manifest),
      bytes:
        Buffer.byteLength(text) +
        [...manifest.chunks, ...manifest.checkpoints].reduce((n, r) => n + r.bytes, 0),
    };
  }
  /** Every compressed byte is checked; semantic verification needs a bound trusted receipt. */
  verified(id: string) {
    return this.bound(id, true);
  }
  /**
   * One stored file for random access: a seek reads only what it needs (ADR 0006). The
   * manifest stays bound to the DB reference and the requested file to its own size and
   * checksum; other files are checked when they are read or the replay is opened again.
   */
  async file(id: string, file: string) {
    const manifest = await this.bound(id, false);
    const ref = [...manifest.chunks, ...manifest.checkpoints].find((r) => r.file === file);
    if (!ref) throw new StoreError('not-found', 'Replay file not found');
    return this.held(id, async () => {
      const bytes = await readBoundedFile(join(replayDirectory(this.root, id), file), ref.bytes);
      if (bytes.length !== ref.bytes || sha256(bytes) !== ref.checksum)
        throw new Error('Replay file size or checksum mismatch');
      return bytes;
    });
  }
  private async bound(id: string, full: boolean) {
    const artifact = this.jobs.artifact(id);
    if (!artifact) throw new StoreError('not-found', 'Replay not found');
    if (artifact.state !== 'ready')
      throw new StoreError('unavailable', `Replay is ${artifact.state}; result held`);
    return this.held(id, async () => {
      const manifest = await readReplayManifest(this.root, id, artifact.manifestChecksum);
      if (full) {
        if (artifact.validationProfile === REPLAY_VALIDATION_PROFILE)
          await verifyReplayChecksums(replayDirectory(this.root, id), manifest);
        else await verifyReplayDirectory(replayDirectory(this.root, id), manifest);
      }
      if (
        manifest.attemptId !== artifact.attemptId ||
        this.metadata(manifest).bytes !== artifact.bytes
      )
        throw new Error('Replay reference binding mismatch');
      if (
        full &&
        artifact.validationProfile !== REPLAY_VALIDATION_PROFILE &&
        !this.jobs.markArtifactValidated(id, artifact.manifestChecksum, REPLAY_VALIDATION_PROFILE)
      )
        throw new Error('Replay reference changed during verification');
      return manifest;
    });
  }
  /** Missing or damaged stored data holds the artifact and the result that refers to it. */
  private async held<T>(id: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      const state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'corrupt';
      this.jobs.markArtifact(id, state);
      throw new StoreError('unavailable', `Replay is ${state}; result held`);
    }
  }
  async discard(id: string) {
    // Never remove a reference that won completion/cancellation ordering.
    if (!this.jobs.artifact(id))
      await rm(replayDirectory(this.root, id), { recursive: true, force: true });
  }
}
