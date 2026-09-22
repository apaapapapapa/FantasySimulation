import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  canonicalJson,
  parseJson,
  replayContext,
  ReplayState,
  ReplayManifestSchema,
  RECORDING_PROFILE,
  eventHashLine,
  trajectoryHashLine,
  StreamRecordSchema,
  type ReplayManifest,
  type ReplayCheckpoint,
} from '@fantasy/domain/spatial';
import { replayDirectory, writeCompressed } from './replay-files.ts';
import { recordEvents, verifyReplayDirectory } from './replay-reader.ts';

type Identity = { id: string; attemptId: string; simulationHash: string; input: unknown };
/** One writer per attempt. Await append to enforce backpressure; one chunk is retained. */
export class ReplayWriter {
  private readonly replay: ReplayState;
  private readonly events = createHash('sha256');
  private readonly trajectory = createHash('sha256');
  private checkpoint: ReplayCheckpoint;
  private lines: string[] = [];
  private rawBytes = 0;
  private storedBytes = 0;
  private expandedBytes = 0;
  private readonly chunks: ReplayManifest['chunks'] = [];
  private readonly checkpoints: ReplayManifest['checkpoints'] = [];
  private busy = false;
  private sealed = false;
  private constructor(
    private readonly root: string,
    private readonly directory: string,
    private readonly identity: Identity,
    context: Awaited<ReturnType<typeof replayContext>>,
  ) {
    this.replay = new ReplayState(context);
    this.checkpoint = this.replay.checkpoint();
  }
  static async create(root: string, identity: Identity) {
    replayDirectory(root, identity.id);
    const context = await replayContext(identity.input, identity.simulationHash);
    const directory = join(root, `.staging-${randomUUID()}`);
    await mkdir(root, { recursive: true });
    await mkdir(directory);
    return new ReplayWriter(
      root,
      directory,
      { ...identity, input: structuredClone(identity.input) },
      context,
    );
  }
  async append(input: unknown) {
    if (this.busy || this.sealed) throw new Error('Writer requires sequential awaited appends');
    this.busy = true;
    try {
      // Validate before changing hashes or pending bytes. ReplayState is atomic on failure.
      const parsed = parseJson(StreamRecordSchema, input),
        line = `${canonicalJson(parsed)}\n`;
      if (this.rawBytes + Buffer.byteLength(line) > 4_000_001) await this.flush();
      const record = this.replay.apply(parsed);
      this.lines.push(line);
      this.rawBytes += Buffer.byteLength(line);
      for (const event of recordEvents(record)) this.events.update(eventHashLine(event));
      this.trajectory.update(trajectoryHashLine(record));
      if (
        this.rawBytes >= RECORDING_PROFILE.targetChunkBytes ||
        this.replay.step - this.checkpoint.step >= RECORDING_PROFILE.maxCheckpointSteps
      )
        await this.flush();
    } catch (error) {
      // A filesystem/size failure makes this writer unusable; never publish a partial successful result.
      this.sealed = true;
      throw error;
    } finally {
      this.busy = false;
    }
  }
  private async flush() {
    if (!this.lines.length) return;
    const index = this.chunks.length,
      suffix = String(index).padStart(5, '0');
    const checkpoint = await writeCompressed(
      this.directory,
      `checkpoint-${suffix}.json.gz`,
      canonicalJson(this.checkpoint),
    );
    const chunk = await writeCompressed(
      this.directory,
      `chunk-${suffix}.ndjson.gz`,
      this.lines.join(''),
    );
    this.storedBytes += checkpoint.bytes + chunk.bytes;
    this.expandedBytes += checkpoint.rawBytes + chunk.rawBytes;
    if (
      this.storedBytes > RECORDING_PROFILE.maxStoredBytes ||
      this.expandedBytes > RECORDING_PROFILE.maxRawBytes
    )
      throw new Error('Replay total byte limit');
    this.checkpoints.push({
      ...checkpoint,
      index,
      step: this.checkpoint.step,
      nextRecord: this.checkpoint.nextRecord,
    });
    this.chunks.push({
      ...chunk,
      index,
      firstRecord: this.checkpoint.nextRecord,
      records: this.lines.length,
      fromStep: this.checkpoint.step,
      toStep: this.replay.step,
      checkpoint: index,
    });
    this.checkpoint = this.replay.checkpoint();
    this.lines = [];
    this.rawBytes = 0;
  }
  async finish(end: ReplayManifest['end'], resultId: string | null) {
    if (this.busy || this.sealed) throw new Error('Writer is busy/closed');
    this.sealed = true;
    await this.flush();
    const state = this.replay.checkpoint();
    const manifest = parseJson(ReplayManifestSchema, {
      schemaVersion: 1,
      ...this.identity,
      resultId,
      profile: RECORDING_PROFILE,
      lastVerifiedStep: state.state === null ? null : state.step,
      records: state.nextRecord,
      eventHash: `sha256:${this.events.digest('hex')}`,
      trajectoryHash: `sha256:${this.trajectory.digest('hex')}`,
      end,
      checkpoints: this.checkpoints,
      chunks: this.chunks,
    });
    await verifyReplayDirectory(this.directory, manifest);
    const handle = await open(join(this.directory, 'manifest.json'), 'wx');
    try {
      await handle.writeFile(canonicalJson(manifest));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(this.directory, replayDirectory(this.root, this.identity.id));
    // Only after this returns may the coordinator commit the database reference.
    return manifest;
  }
  async discard() {
    if (this.busy) throw new Error('Wait for pending append before discarding');
    this.sealed = true;
    await rm(this.directory, { recursive: true, force: true });
  }
}
