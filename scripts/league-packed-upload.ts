import { join } from 'node:path';
import { mkdir, rename, rm } from 'node:fs/promises';
import { canonicalJson } from '@fantasy/domain/spatial';
import { currentMeasurements } from '@fantasy/api/tooling';
import { writeCloudJson } from '../apps/cli/src/league/league-cloud-files.ts';
import { publicationDirectory } from '../apps/cli/src/publication/publication-files.ts';
import type {
  PipelineIdentity,
  sealLeagueProducer,
} from '../apps/cli/src/league/league-producer.ts';
import {
  packedIndex,
  packedProducerDescriptor,
  packedArtifactName,
  PackedCapacityError,
  PACKED_RAW_BYTES,
  PACKED_INDEX_BYTES,
} from '../apps/cli/src/league/league-producer-transport.ts';
import { uploadPipelineArtifact } from './league-pipeline-upload.ts';
import type { PipelineArtifact } from './league-pipeline-artifacts.ts';

type Descriptor = Awaited<ReturnType<typeof packedProducerDescriptor>>;
type Group = { root: string; partitions: Descriptor[]; bytes: number; sealedAt: number };

/** Diagnostic only: one serialized upload/group plus one caller-owned current sealed producer. */
export class PackedLeagueUpload {
  private group: Group | undefined;
  private sequence = 0;
  private partitions = 0;
  private tail = Promise.resolve();
  private failure: unknown;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly aborted = () => {
    void this.close().catch((error) => {
      this.failure ??= error;
    });
  };
  constructor(
    private readonly root: string,
    private readonly identity: PipelineIdentity,
    private readonly runner: number,
    private readonly signal: AbortSignal,
    private readonly artifacts: PipelineArtifact[],
    private readonly upload = uploadPipelineArtifact,
  ) {
    signal.addEventListener('abort', this.aborted, { once: true });
  }
  private enqueue(work: () => Promise<void>) {
    const next = this.tail.then(async () => {
      this.signal.throwIfAborted();
      if (this.closed) throw new Error('Packed uploader closed');
      if (this.failure !== undefined) throw this.failure;
      await work();
    });
    // A timer failure stays terminal, but does not become an unhandled rejection.
    this.tail = next.catch((error) => {
      this.failure ??= error;
    });
    return next;
  }
  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
  private indexBytes(partitions: Descriptor[]) {
    try {
      const index = packedIndex(this.identity, this.runner, this.sequence, partitions);
      const bytes = Buffer.byteLength(canonicalJson(index));
      return { index, bytes };
    } catch (error) {
      if (error instanceof PackedCapacityError) return undefined;
      throw error;
    }
  }
  private async flushNow() {
    this.clearTimer();
    const group = this.group;
    if (!group) return;
    currentMeasurements()?.queue(
      'artifact.pack.bufferResidence',
      Math.max(0, performance.now() - group.sealedAt),
      group.partitions.length,
    );
    currentMeasurements()?.queue(
      'artifact.pack.flushOvershoot',
      Math.max(0, performance.now() - group.sealedAt - 5000),
      0,
    );
    try {
      const measured = this.indexBytes(group.partitions);
      if (!measured) throw new Error('Adopted packed group exceeds capacity');
      const { index, bytes } = measured;
      if (
        bytes > PACKED_INDEX_BYTES ||
        group.bytes + bytes > PACKED_RAW_BYTES ||
        this.artifacts.length + 1 > 30
      )
        throw new Error('Packed raw-byte or producer artifact quota exceeded');
      await writeCloudJson(join(group.root, 'index.json'), index);
      this.signal.throwIfAborted();
      this.artifacts.push(
        await this.upload(
          packedArtifactName(this.identity, this.runner, this.sequence),
          [
            join(group.root, 'index.json'),
            ...group.partitions.flatMap((partition) =>
              partition.files.map((file) => join(group.root, file.path)),
            ),
          ],
          group.root,
        ),
      );
      this.signal.throwIfAborted();
      this.sequence++;
    } finally {
      this.group = undefined;
      await rm(group.root, { recursive: true, force: true });
    }
  }
  async append(
    producerRoot: string,
    proof: Awaited<ReturnType<typeof sealLeagueProducer>>,
    sealedAt = performance.now(),
  ) {
    if (!Number.isFinite(sealedAt) || sealedAt < 0 || sealedAt > performance.now())
      throw new Error('Invalid sealed producer monotonic timestamp');
    let accepted = false;
    await this.enqueue(async () => {
      if (++this.partitions > 10) throw new Error('Packed producer partition quota exceeded');
      if (
        canonicalJson(proof.identity) !== canonicalJson(this.identity) ||
        proof.runner !== this.runner
      )
        throw new Error('Foreign packed producer identity or runner');
      const descriptor = await packedProducerDescriptor(producerRoot, proof);
      this.signal.throwIfAborted();
      const bytes = descriptor.files.reduce((n, file) => n + file.bytes, 0);
      // This envelope concerns producer spools only, not result DBs or whole-process disk.
      if (bytes + (this.group?.bytes ?? 0) + PACKED_INDEX_BYTES > 192 * 1024 ** 2)
        throw new Error('Packed producer spool disk envelope exceeded');
      const single = this.indexBytes([descriptor]);
      if (!single || single.bytes > PACKED_INDEX_BYTES || bytes + single.bytes > PACKED_RAW_BYTES) {
        await this.flushNow();
        return; // Preserve the caller's complete legacy multipart producer.
      }
      if (this.group) {
        const pair =
          this.group.partitions.length === 2
            ? undefined
            : this.indexBytes([...this.group.partitions, descriptor]);
        if (
          !pair ||
          pair.bytes > PACKED_INDEX_BYTES ||
          this.group.bytes + bytes + pair.bytes > PACKED_RAW_BYTES
        )
          await this.flushNow();
      }
      const nextIndex = this.indexBytes([descriptor]);
      if (
        !nextIndex ||
        nextIndex.bytes > PACKED_INDEX_BYTES ||
        bytes + nextIndex.bytes > PACKED_RAW_BYTES
      )
        return;
      if (!this.group) {
        const root = join(this.root, String(this.sequence));
        await publicationDirectory(this.root, true);
        await mkdir(root);
        this.group = { root, partitions: [], bytes: 0, sealedAt };
        await mkdir(join(root, 'partitions'));
      }
      await rename(producerRoot, join(this.group.root, 'partitions', String(descriptor.partition)));
      this.group.partitions.push(descriptor);
      this.group.bytes += bytes;
      accepted = true;
      this.signal.throwIfAborted();
      if (this.group.partitions.length === 2) await this.flushNow();
      else if (this.timer === undefined) {
        this.timer = setTimeout(
          () => {
            void this.flush().catch(() => {});
          },
          Math.max(0, 5000 - (performance.now() - sealedAt)),
        );
        this.timer.unref();
      }
    });
    return accepted;
  }
  flush() {
    return this.enqueue(() => this.flushNow());
  }
  async finish() {
    await this.flush();
    await this.tail;
    this.clearTimer();
    if (this.failure !== undefined) throw this.failure;
    this.signal.throwIfAborted();
  }
  async close() {
    this.closed = true;
    this.clearTimer();
    this.signal.removeEventListener('abort', this.aborted);
    await this.tail;
    this.clearTimer();
    const group = this.group;
    this.group = undefined;
    if (group) await rm(group.root, { recursive: true, force: true });
  }
}
