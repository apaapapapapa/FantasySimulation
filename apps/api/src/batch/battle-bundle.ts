import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, opendir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BundleReceiptSchema,
  BundleReceiptBodySchema,
  ReplayManifestSchema,
  HashSchema,
  canonicalJson,
  contentHash,
  MAX_REPLAY_MANIFEST_BYTES,
  parseJson,
  type ExecutionSource,
  type BundleReceipt,
  type ReplayManifest,
} from '@fantasy/domain/spatial';
import {
  readBoundedFile,
  sha256,
  syncDirectory,
  writeDurableFile,
  publishImmutableFile,
  GENERATED_UUID,
} from '../replay/replay-files.ts';
import { verifyReplayDirectory } from '../replay/replay-reader.ts';
import { OperationError, operationInput } from '../operation-error.ts';
import type { BattleService } from '../jobs/battle-service.ts';

const hashName = (hash: string) => HashSchema.parse(hash).slice(7);
export class BattleBundles {
  private bytes: number | null = null;
  constructor(
    readonly root: string,
    readonly maxBytes = 16 * 1024 ** 3,
  ) {}
  private objectPath(hash: string) {
    return join(this.root, 'objects', hashName(hash));
  }
  async verify(objectHash: string): Promise<BundleReceipt> {
    const directory = this.objectPath(objectHash);
    if (!(await lstat(directory)).isDirectory())
      throw new OperationError('DATA_INVALID', 'Invalid bundle directory');
    const receiptBytes = await readBoundedFile(join(directory, 'receipt.json'), 65536);
    const receipt = operationInput(
      () =>
        parseJson(
          BundleReceiptSchema,
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receiptBytes)) as unknown,
        ),
      'DATA_INVALID',
    );
    const { objectHash: recorded, ...body } = receipt;
    if (recorded !== objectHash || recorded !== (await contentHash(body)))
      throw new OperationError('DATA_INVALID', 'Bundle receipt hash mismatch');
    const { manifest, manifestBytes } = await this.readManifest(receipt);
    const bytes =
      manifestBytes.length +
      [...manifest.chunks, ...manifest.checkpoints].reduce((n, ref) => n + ref.bytes, 0);
    if (
      manifest.id !== receipt.replayId ||
      manifest.attemptId !== receipt.attemptId ||
      manifest.resultId !== receipt.resultId ||
      manifest.simulationHash !== receipt.simulationHash ||
      manifest.end.kind !== 'result' ||
      canonicalJson(manifest.end.result) !== canonicalJson(receipt.result) ||
      sha256(canonicalJson(receipt.result)) !== receipt.resultHash ||
      bytes !== receipt.bytes
    )
      throw new OperationError('DATA_INVALID', 'Bundle result/attempt/replay binding mismatch');
    await verifyReplayDirectory(directory, manifest);
    return receipt;
  }
  /** The checksum still applies when a consumer reads the saved input after full verification. */
  async manifest(receipt: BundleReceipt): Promise<ReplayManifest> {
    return (await this.readManifest(receipt)).manifest;
  }
  private async readManifest(receipt: BundleReceipt) {
    const manifestBytes = await readBoundedFile(
      join(this.objectPath(receipt.objectHash), 'manifest.json'),
      MAX_REPLAY_MANIFEST_BYTES,
    );
    if (sha256(manifestBytes) !== receipt.manifestChecksum)
      throw new OperationError('DATA_INVALID', 'Bundle manifest checksum mismatch');
    const manifest = operationInput(
      () =>
        parseJson(
          ReplayManifestSchema,
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as unknown,
        ),
      'DATA_INVALID',
    );
    return { manifest, manifestBytes };
  }
  async cached(simulationHash: string) {
    let bytes: Buffer;
    try {
      bytes = await readBoundedFile(
        join(this.root, 'complete', hashName(simulationHash) + '.json'),
        100,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const objectHash = operationInput(
      () => HashSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))),
      'DATA_INVALID',
    );
    const receipt = await this.verify(objectHash);
    if (
      receipt.simulationHash !== simulationHash ||
      !['win', 'draw'].includes(receipt.result.outcome.kind)
    )
      throw new OperationError('DATA_INVALID', 'Definitive bundle pointer mismatch');
    return receipt;
  }
  async storedBytes() {
    if (this.bytes !== null) return this.bytes;
    let total = 0;
    const scan = async (directory: string): Promise<void> => {
      for await (const entry of await opendir(directory)) {
        const path = join(directory, entry.name);
        if (
          entry.isDirectory() &&
          directory === join(this.root, 'objects') &&
          /^[0-9a-f]{64}$/.test(entry.name)
        )
          await scan(path);
        else if (entry.isFile()) total += (await lstat(path)).size;
        else throw new OperationError('DATA_INVALID', 'Unexpected bundle storage entry');
        if (total > this.maxBytes)
          throw new OperationError('BUDGET_EXCEEDED', 'Bundle storage limit exceeded');
      }
    };
    for (const name of ['objects', 'complete', 'indexes', 'plans']) {
      const directory = join(this.root, name);
      await mkdir(directory, { recursive: true });
      if (!(await lstat(directory)).isDirectory())
        throw new OperationError('DATA_INVALID', 'Invalid bundle collection');
      await scan(directory);
    }
    this.bytes = total;
    return total;
  }
  /** Called only after the local coordinator has acquired exclusive ownership. */
  async recoverStaging() {
    const remove = async (directory: string, prefix: string) => {
      for await (const entry of await opendir(directory))
        if (entry.name.startsWith(prefix) && GENERATED_UUID.test(entry.name.slice(prefix.length)))
          await rm(join(directory, entry.name), { recursive: true, force: true });
    };
    await remove(this.root, '.bundle-staging-');
    for (const name of ['complete', 'indexes', 'plans']) {
      const directory = join(this.root, name);
      await mkdir(directory, { recursive: true });
      if (!(await lstat(directory)).isDirectory())
        throw new OperationError('DATA_INVALID', 'Invalid bundle collection');
      await remove(directory, '.immutable-staging-');
    }
    this.bytes = null;
  }
  private async capacity(bytes: number, reserve = 0) {
    if ((await this.storedBytes()) + bytes + reserve > this.maxBytes)
      throw new OperationError(
        'BUDGET_EXCEEDED',
        'Bundle storage limit exceeded before publication',
      );
  }
  async publishJson(collection: 'plans' | 'indexes', id: string, value: unknown) {
    const text = canonicalJson(value),
      limit = collection === 'plans' ? 8_000_000 : 2_000_000;
    if (Buffer.byteLength(text) > limit)
      throw new OperationError('BUDGET_EXCEEDED', 'Batch document byte limit');
    const path = join(this.root, collection, hashName(id) + '.json');
    try {
      const previous = await readBoundedFile(path, limit);
      if (previous.toString('utf8') !== text)
        throw new OperationError('DATA_INVALID', 'Immutable batch document collision');
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await this.capacity(Buffer.byteLength(text), collection === 'plans' ? 2_000_000 : 0);
    await publishImmutableFile(path, text);
    this.bytes! += Buffer.byteLength(text);
    return path;
  }
  private async publishPointer(receipt: BundleReceipt) {
    if (!['win', 'draw'].includes(receipt.result.outcome.kind)) return;
    const original = await this.cached(receipt.simulationHash);
    if (original) {
      if (original.resultHash !== receipt.resultHash)
        throw new OperationError('DATA_INVALID', 'Definitive bundle publication conflict');
      return;
    }
    const text = canonicalJson(receipt.objectHash);
    await this.capacity(Buffer.byteLength(text), 2_000_000);
    await publishImmutableFile(
      join(this.root, 'complete', hashName(receipt.simulationHash) + '.json'),
      text,
    );
    this.bytes! += Buffer.byteLength(text);
  }
  async publish(runtime: BattleService, resultId: string, source: ExecutionSource) {
    const snapshot = await runtime.resultSnapshot(resultId);
    const { manifest, response: result } = snapshot;
    const simulationHash = result.result.simulationHash;
    const body = parseJson(BundleReceiptBodySchema, {
      schemaVersion: 1,
      source,
      simulationHash,
      resultId: result.id,
      replayId: manifest.id,
      attemptId: manifest.attemptId,
      resultHash: snapshot.resultHash,
      manifestChecksum: sha256(canonicalJson(manifest)),
      bytes: snapshot.bytes,
      result: result.result,
    });
    const receipt: BundleReceipt = { ...body, objectHash: await contentHash(body) };
    return this.publishObject(receipt, manifest, (ref) =>
      runtime.replayFile(manifest.id, ref.file),
    );
  }
  /** Retained results enter a new shard only after complete receipt/replay verification. */
  async importConfirmed(source: BattleBundles, objectHash: string) {
    return this.importBundle(source, objectHash, true);
  }
  /** Copy historical partial attempts without making them eligible for result reuse. */
  async importRecorded(source: BattleBundles, objectHash: string) {
    return this.importBundle(source, objectHash, false);
  }
  private async importBundle(source: BattleBundles, objectHash: string, definitive: boolean) {
    const receipt = await source.verify(objectHash);
    if (definitive && !['win', 'draw'].includes(receipt.result.outcome.kind))
      throw new OperationError('DATA_INVALID', 'Only definitive bundles can be reused');
    const directory = source.objectPath(objectHash);
    const manifestBytes = await readBoundedFile(
      join(directory, 'manifest.json'),
      MAX_REPLAY_MANIFEST_BYTES,
    );
    const manifest = operationInput(
      () =>
        parseJson(
          ReplayManifestSchema,
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes)) as unknown,
        ),
      'DATA_INVALID',
    );
    if (sha256(canonicalJson(manifest)) !== receipt.manifestChecksum)
      throw new OperationError('DATA_INVALID', 'Retained manifest changed during import');
    return this.publishObject(receipt, manifest, (ref) =>
      readBoundedFile(join(directory, ref.file), ref.bytes),
    );
  }
  private async publishObject(
    receipt: BundleReceipt,
    manifest: ReplayManifest,
    load: (
      ref: ReplayManifest['chunks'][number] | ReplayManifest['checkpoints'][number],
    ) => Promise<Buffer>,
  ) {
    const original = await this.cached(receipt.simulationHash);
    if (original && ['win', 'draw'].includes(receipt.result.outcome.kind)) {
      if (original.resultHash !== receipt.resultHash)
        throw new OperationError('DATA_INVALID', 'Definitive bundle result disagreement');
      return original;
    }
    const receiptText = canonicalJson(receipt);
    // A crash after object rename but before pointer publication must not double-count its bytes.
    try {
      const existing = await this.verify(receipt.objectHash);
      if (canonicalJson(existing) !== receiptText)
        throw new OperationError('DATA_INVALID', 'Bundle object collision');
      await this.publishPointer(existing);
      return existing;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const bytes = receipt.bytes + Buffer.byteLength(receiptText);
    await this.capacity(bytes + 100, 2_000_000);
    const staging = join(this.root, `.bundle-staging-${randomUUID()}`);
    await mkdir(staging);
    try {
      for (const ref of [...manifest.chunks, ...manifest.checkpoints]) {
        const bytes = await load(ref);
        if (bytes.length !== ref.bytes || sha256(bytes) !== ref.checksum)
          throw new OperationError('DATA_INVALID', 'Replay changed during export');
        await writeDurableFile(join(staging, ref.file), bytes);
      }
      await writeDurableFile(join(staging, 'manifest.json'), canonicalJson(manifest));
      await writeDurableFile(join(staging, 'receipt.json'), receiptText);
      await verifyReplayDirectory(staging, manifest);
      await syncDirectory(staging);
      try {
        await rename(staging, this.objectPath(receipt.objectHash));
        this.bytes! += bytes;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
        if (canonicalJson(await this.verify(receipt.objectHash)) !== receiptText)
          throw new OperationError('DATA_INVALID', 'Bundle object collision');
        this.bytes = null;
      }
      await syncDirectory(join(this.root, 'objects'));
      await this.publishPointer(receipt);
      return receipt;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
