import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { PublicKeySchema } from '@fantasy/domain/spatial';
import { PUBLICATION_MAX_BYTES, PUBLICATION_MAX_FILES } from './publication-files.ts';
import type { PublicationStore } from './publication-remote.ts';

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}
export class PublicationS3 implements PublicationStore {
  private readonly client: S3Client;
  private readonly signal = AbortSignal.timeout(300_000);
  private requests = 0;
  private transferred = 0;
  private writes = 0;
  private uploaded = 0;
  metrics() {
    return {
      logicalRequests: this.requests,
      successfulWrites: this.writes,
      readBytes: this.transferred,
      uploadedBytes: this.uploaded,
    };
  }
  constructor(private readonly config: R2Config) {
    if (
      !/^[a-f0-9]{32}$/.test(config.accountId) ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) ||
      !config.accessKeyId ||
      !config.secretAccessKey
    )
      throw new Error('R2 bucket-scoped credentials/configuration are required');
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: 3,
      retryMode: 'standard',
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  close() {
    this.client.destroy();
  }
  private options() {
    if (++this.requests > 100_000) throw new Error('S3 request budget exceeded');
    this.signal.throwIfAborted();
    return { abortSignal: this.signal };
  }
  private input(key: string) {
    return { Bucket: this.config.bucket, Key: PublicKeySchema.parse(key) };
  }
  private status(error: unknown) {
    return error && typeof error === 'object'
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
      : undefined;
  }
  private failure(error: unknown): never {
    throw new Error(
      `S3 operation failed (HTTP ${this.status(error) ?? 'unknown'}); no credentials logged`,
    );
  }
  async inventory() {
    const result = new Map<string, number>();
    let cursor: string | undefined,
      bytes = 0;
    do {
      const page = await this.client
        .send(
          new ListObjectsV2Command({
            Bucket: this.config.bucket,
            MaxKeys: 1000,
            ...(cursor ? { ContinuationToken: cursor } : {}),
          }),
          this.options(),
        )
        .catch((e) => this.failure(e));
      for (const item of page.Contents ?? []) {
        const key = PublicKeySchema.parse(item.Key),
          size = item.Size;
        if (size === undefined || !Number.isSafeInteger(size) || size < 0 || result.has(key))
          throw new Error('Invalid S3 inventory');
        result.set(key, size);
        bytes += size;
        if (result.size > PUBLICATION_MAX_FILES || bytes > PUBLICATION_MAX_BYTES)
          throw new Error('Existing S3 capacity exceeds publication budget');
      }
      if (
        page.IsTruncated &&
        (!page.NextContinuationToken || page.NextContinuationToken === cursor)
      )
        throw new Error('Incomplete S3 inventory');
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (cursor);
    return result;
  }
  async read(key: string, limit: number) {
    try {
      const value = await this.client.send(new GetObjectCommand(this.input(key)), this.options());
      if (!value.Body || !value.ETag) throw new Error('Incomplete S3 body');
      const reader = value.Body.transformToWebStream().getReader(),
        parts: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (let part = await reader.read(); !part.done; part = await reader.read()) {
          bytes += part.value.byteLength;
          this.transferred += part.value.byteLength;
          if (this.transferred > PUBLICATION_MAX_BYTES)
            throw new Error('S3 total read byte budget');
          if (bytes > limit) throw new Error('S3 object byte limit');
          parts.push(part.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      return { data: Buffer.concat(parts), etag: value.ETag };
    } catch (error) {
      if (this.status(error) === 404) return null;
      this.failure(error);
    }
  }
  async head(key: string) {
    try {
      return (
        (await this.client.send(new HeadObjectCommand(this.input(key)), this.options()))
          .ContentLength ?? null
      );
    } catch (error) {
      if (this.status(error) === 404) return null;
      this.failure(error);
    }
  }
  async put(key: string, data: Buffer, previousEtag: string | null) {
    await this.client
      .send(
        new PutObjectCommand({
          ...this.input(key),
          Body: data,
          ContentType: key.endsWith('.gz') ? 'application/gzip' : 'application/json',
          CacheControl:
            key === 'catalog/current.json'
              ? 'public, max-age=30, no-transform'
              : 'public, max-age=31536000, immutable, no-transform',
          ...(previousEtag === null ? { IfNoneMatch: '*' } : { IfMatch: previousEtag }),
        }),
        this.options(),
      )
      .catch((e) => this.failure(e));
    this.writes++;
    this.uploaded += data.length;
  }
  async remove(key: string) {
    if (key === 'catalog/current.json') throw new Error('Cannot delete the publication pointer');
    await this.client
      .send(new DeleteObjectCommand(this.input(key)), this.options())
      .catch((e) => this.failure(e));
  }
}
