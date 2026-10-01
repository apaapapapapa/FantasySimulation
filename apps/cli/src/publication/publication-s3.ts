import { OperationError, operationCode } from '@fantasy/api/tooling';
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import {
  PublicKeySchema,
  LeagueUsageSchema,
  type LeagueBillingObservation,
} from '@fantasy/domain/spatial';
import {
  PUBLICATION_MAX_BYTES,
  PUBLICATION_MAX_FILES,
  PUBLICATION_CONTROL_KEY,
  PUBLICATION_CONTROL_BYTES,
  isLeagueCheckpointKey,
} from './publication-files.ts';
import type { PublicationStore } from './publication-remote.ts';
import { startMeasurement, measureAsync } from '@fantasy/api/tooling';
import { publicationConcurrency } from './publication-pool.ts';

export interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  billingObservation?: LeagueBillingObservation;
}
export interface S3PublicationBudget {
  maxRequests: number;
  maxClassARequests: number;
  maxClassBRequests: number;
  deadlineMs: number;
  maxAttempts: 1 | 3;
  /**
   * Retries of a failed data GET/HEAD/PUT/LIST after 429, 5xx or a lost connection. Each
   * retry is a new logical request charged to the same class budget; control writes never retry.
   */
  transientRetries?: 0 | 1 | 2;
}
export class PublicationS3 implements PublicationStore {
  private readonly client: S3Client;
  private readonly signal: AbortSignal;
  private readonly budget: S3PublicationBudget;
  private requests = 0;
  private classARequests = 0;
  private classBRequests = 0;
  private transferred = 0;
  private writes = 0;
  private uploaded = 0;
  private retries = 0;
  private readonly etags = new Map<string, string>();
  remainingRequests() {
    return this.budget.maxRequests - this.requests;
  }
  metrics() {
    return {
      logicalRequests: this.requests,
      classARequests: this.classARequests,
      classBRequests: this.classBRequests,
      maxAttempts: this.budget.maxAttempts,
      successfulWrites: this.writes,
      readBytes: this.transferred,
      uploadedBytes: this.uploaded,
      transientRetries: this.retries,
    };
  }
  constructor(
    private readonly config: R2Config,
    budget: Partial<S3PublicationBudget> = {},
    maxSockets = 50,
  ) {
    publicationConcurrency(maxSockets, 64);
    this.budget = {
      maxRequests: 100_000,
      maxClassARequests: 100_000,
      maxClassBRequests: 100_000,
      deadlineMs: 300_000,
      maxAttempts: 3,
      transientRetries: 0,
      ...budget,
    };
    for (const [key, maximum] of [
      ['maxRequests', 2_000_000],
      ['maxClassARequests', 900_000],
      ['maxClassBRequests', 2_000_000],
      ['deadlineMs', 10_800_000],
    ] as const) {
      const value = this.budget[key];
      if (!Number.isInteger(value) || value < 1 || value > maximum)
        throw new OperationError('INPUT_INVALID', 'Invalid S3 publication budget');
    }
    if (
      ![1, 3].includes(this.budget.maxAttempts) ||
      ![0, 1, 2].includes(this.budget.transientRetries ?? 0)
    )
      throw new OperationError('INPUT_INVALID', 'Invalid S3 retry budget');
    this.signal = AbortSignal.timeout(this.budget.deadlineMs);
    if (
      !/^[a-f0-9]{32}$/.test(config.accountId) ||
      !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket) ||
      !config.accessKeyId ||
      !config.secretAccessKey
    )
      throw new OperationError(
        'INPUT_INVALID',
        'R2 bucket-scoped credentials/configuration are required',
      );
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      maxAttempts: this.budget.maxAttempts,
      retryMode: 'standard',
      requestHandler: { httpsAgent: { keepAlive: true, maxSockets, maxTotalSockets: maxSockets } },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  close() {
    this.client.destroy();
  }
  private options(kind: 'A' | 'B') {
    if (this.remainingRequests() < 1)
      throw new OperationError('BUDGET_EXCEEDED', 'S3 request budget exceeded');
    if (
      (kind === 'A' && this.classARequests >= this.budget.maxClassARequests) ||
      (kind === 'B' && this.classBRequests >= this.budget.maxClassBRequests)
    )
      throw new OperationError('BUDGET_EXCEEDED', 'S3 request class budget exceeded');
    if (this.signal.aborted)
      throw new OperationError('BUDGET_EXCEEDED', 'S3 transport deadline exceeded');
    this.requests++;
    if (kind === 'A') this.classARequests++;
    else this.classBRequests++;
    return { abortSignal: this.signal };
  }
  private input(key: string, control = false) {
    return {
      Bucket: this.config.bucket,
      Key:
        (control && key === PUBLICATION_CONTROL_KEY) || isLeagueCheckpointKey(key)
          ? key
          : PublicKeySchema.parse(key),
    };
  }
  private status(error: unknown) {
    const status =
      error && typeof error === 'object'
        ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
        : undefined;
    return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : undefined;
  }
  private failure(error: unknown): never {
    const status = this.status(error),
      code = operationCode(error);
    throw new OperationError(
      code !== 'UNKNOWN'
        ? code
        : this.signal.aborted
          ? 'BUDGET_EXCEEDED'
          : status === 401 || status === 403
            ? 'REMOTE_AUTH'
            : status === 409 || status === 412
              ? 'PUBLICATION_CONFLICT'
              : 'REMOTE_UNAVAILABLE',
      `S3 operation failed (HTTP ${status ?? 'unknown'}); no credentials logged`,
    );
  }
  /**
   * 429, 5xx, connection loss and per-request socket timeouts (no HTTP status) are transient;
   * validation errors are not, and nothing retries once the transport deadline has expired.
   */
  private transient(error: unknown) {
    if (error instanceof OperationError || this.signal.aborted) return false;
    const status = this.status(error);
    return status === undefined || status === 429 || status >= 500;
  }
  /** Charges every attempt before sending; backoff stays inside the transport deadline. */
  private async attempt<T>(
    kind: 'A' | 'B',
    work: (options: { abortSignal: AbortSignal }) => Promise<T>,
  ) {
    for (let retry = 0; ; retry++) {
      try {
        return await work(this.options(kind));
      } catch (error) {
        if (retry >= (this.budget.transientRetries ?? 0) || !this.transient(error)) throw error;
        this.retries++;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 250 * 4 ** retry);
          this.signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), {
            once: true,
          });
        });
      }
    }
  }
  /** ETags from the latest inventory; single-part R2 ETags are the object's MD5. */
  listedEtags(): ReadonlyMap<string, string> {
    return this.etags;
  }
  async inventory() {
    const result = new Map<string, number>();
    this.etags.clear();
    let cursor: string | undefined,
      bytes = 0;
    do {
      const page = await measureAsync('r2.LIST', () =>
        this.attempt('A', (options) =>
          this.client.send(
            new ListObjectsV2Command({
              Bucket: this.config.bucket,
              MaxKeys: 1000,
              ...(cursor ? { ContinuationToken: cursor } : {}),
            }),
            options,
          ),
        ).catch((e) => (e instanceof OperationError ? Promise.reject(e) : this.failure(e))),
      );
      for (const item of page.Contents ?? []) {
        if (typeof item.Key !== 'string')
          throw new OperationError('DATA_INVALID', 'Missing S3 inventory key');
        const key =
            item.Key === PUBLICATION_CONTROL_KEY || isLeagueCheckpointKey(item.Key)
              ? item.Key
              : PublicKeySchema.parse(item.Key),
          size = item.Size;
        if (size === undefined || !Number.isSafeInteger(size) || size < 0 || result.has(key))
          throw new OperationError('DATA_INVALID', 'Invalid S3 inventory');
        if (key === PUBLICATION_CONTROL_KEY && size > PUBLICATION_CONTROL_BYTES)
          throw new OperationError('DATA_INVALID', 'Invalid league usage ledger size');
        result.set(key, size);
        if (item.ETag) this.etags.set(key, item.ETag);
        bytes += size;
        if (result.size > PUBLICATION_MAX_FILES || bytes > PUBLICATION_MAX_BYTES)
          throw new OperationError(
            'BUDGET_EXCEEDED',
            'Existing S3 capacity exceeds publication budget',
          );
      }
      if (
        page.IsTruncated &&
        (!page.NextContinuationToken || page.NextContinuationToken === cursor)
      )
        throw new OperationError('DATA_INVALID', 'Incomplete S3 inventory');
      cursor = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (cursor);
    return result;
  }
  read(key: string, limit: number) {
    return this.readObject(key, limit);
  }
  readControl() {
    return this.readObject(PUBLICATION_CONTROL_KEY, PUBLICATION_CONTROL_BYTES, true);
  }
  async putControl(data: Buffer, previousEtag: string | null) {
    if (data.length > PUBLICATION_CONTROL_BYTES)
      throw new OperationError('BUDGET_EXCEEDED', 'League usage ledger size limit');
    LeagueUsageSchema.parse(JSON.parse(data.toString('utf8')));
    await this.putObject(PUBLICATION_CONTROL_KEY, data, previousEtag, true);
  }
  private async readObject(key: string, limit: number, control = false) {
    const end = startMeasurement('r2.GET');
    let readBytes = 0;
    let succeeded = false;
    const get = async (options: { abortSignal: AbortSignal }) => {
      const value = await this.client.send(new GetObjectCommand(this.input(key, control)), options);
      if (!value.Body || !value.ETag)
        throw new OperationError('DATA_INVALID', 'Incomplete S3 body');
      const reader = value.Body.transformToWebStream().getReader(),
        parts: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (let part = await reader.read(); !part.done; part = await reader.read()) {
          bytes += part.value.byteLength;
          this.transferred += part.value.byteLength;
          readBytes += part.value.byteLength;
          if (this.transferred > PUBLICATION_MAX_BYTES)
            throw new OperationError('BUDGET_EXCEEDED', 'S3 total read byte budget');
          if (bytes > limit) throw new OperationError('DATA_INVALID', 'S3 object byte limit');
          parts.push(part.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
      return { data: Buffer.concat(parts), etag: value.ETag };
    };
    try {
      // The ledger is a compare-and-swap document: its reads stay single-attempt too.
      const value = control ? await get(this.options('B')) : await this.attempt('B', get);
      succeeded = true;
      return value;
    } catch (error) {
      if (this.status(error) === 404) return null;
      this.failure(error);
    } finally {
      end(succeeded, readBytes);
    }
  }
  async head(key: string) {
    const end = startMeasurement('r2.HEAD');
    let succeeded = false;
    try {
      const bytes =
        (
          await this.attempt('B', (options) =>
            this.client.send(new HeadObjectCommand(this.input(key)), options),
          )
        ).ContentLength ?? null;
      succeeded = true;
      return bytes;
    } catch (error) {
      if (this.status(error) === 404) return null;
      this.failure(error);
    } finally {
      end(succeeded);
    }
  }
  put(key: string, data: Buffer, previousEtag: string | null) {
    return this.putObject(key, data, previousEtag);
  }
  private async putObject(key: string, data: Buffer, previousEtag: string | null, control = false) {
    const end = startMeasurement('r2.PUT');
    let succeeded = false;
    try {
      const put = (options: { abortSignal: AbortSignal }) =>
        this.client.send(
          new PutObjectCommand({
            ...this.input(key, control),
            Body: data,
            ContentType: key.endsWith('.gz') ? 'application/gzip' : 'application/json',
            CacheControl: control
              ? 'private, no-store'
              : key === 'catalog/current.json'
                ? 'public, max-age=30, no-transform'
                : 'public, max-age=31536000, immutable, no-transform',
            ...(previousEtag === null ? { IfNoneMatch: '*' } : { IfMatch: previousEtag }),
          }),
          options,
        );
      // A retried conditional PUT whose first response was lost reports 412; callers then
      // accept only identical stored bytes. Ledger compare-and-swap writes never retry.
      await (control ? put(this.options('A')) : this.attempt('A', put)).catch((e) =>
        this.failure(e),
      );
      this.writes++;
      this.uploaded += data.length;
      succeeded = true;
    } finally {
      end(succeeded, succeeded ? data.length : 0);
    }
  }
  async remove(key: string) {
    if (key === 'catalog/current.json') throw new Error('Cannot delete the publication pointer');
    await this.client
      .send(new DeleteObjectCommand(this.input(key)), this.options('A'))
      .catch((e) => this.failure(e));
  }
}
