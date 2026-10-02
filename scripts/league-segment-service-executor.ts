import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { HashSchema } from '@fantasy/domain/spatial';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  SEGMENT_SERVICE_HTTP_REQUESTS,
  SEGMENT_SERVICE_UPLOAD_BYTES,
  SEGMENT_SERVICE_UPLOAD_NAME,
  segmentServiceUploadKind,
} from './league-segment-service-bounds.ts';
import type { SealedSegmentReceipt } from './league-sealed-zip-diagnostic.ts';

export const SERVICE_UPLOAD_DEADLINE_MS = 300000;
const graceMs = 5000,
  outputLimit = 65536,
  receiptLimit = 4096,
  rssLimit = 1024 ** 3;
export const segmentServiceReceiptSchema = z
  .object({
    name: z.string().regex(SEGMENT_SERVICE_UPLOAD_NAME),
    bytes: z.number().int().min(1).max(SEGMENT_SERVICE_UPLOAD_BYTES.data),
    digest: HashSchema,
    sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
    runtimeHash: HashSchema,
    allocationAttempt: z.union([z.literal(0), z.literal(1)]),
  })
  .strict()
  .refine(
    (value) =>
      value.allocationAttempt === 0 &&
      value.bytes <= SEGMENT_SERVICE_UPLOAD_BYTES[segmentServiceUploadKind(value.name)],
  );
const childReply = z
  .object({
    artifact: z
      .object({
        id: z.number().int().positive().safe(),
        name: z.string(),
        bytes: z.number().int().positive().safe(),
        digest: HashSchema,
      })
      .strict(),
    childMaxRssKiB: z.number().int().positive().safe(),
    physicalHttpRequests: z.number().int().min(0).max(SEGMENT_SERVICE_HTTP_REQUESTS.data),
    physicalHttpRequestLimit: z.union([
      z.literal(SEGMENT_SERVICE_HTTP_REQUESTS.data),
      z.literal(SEGMENT_SERVICE_HTTP_REQUESTS.metrics),
    ]),
  })
  .strict();

/** procfs reports stat.size=0. Bound actual reads, require EOF, and never follow a final symlink. */
async function procStatus(pid: number) {
  const file = await open(
    `/proc/${pid}/status`,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile()) throw new Error('Invalid proc status');
    const bytes = Buffer.alloc(16385);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (!read.bytesRead) return bytes.subarray(0, length).toString('ascii');
      length += read.bytesRead;
    }
    throw new Error('Proc status bound');
  } finally {
    await file.close();
  }
}

/** Supervises an already-spawned child; grants no upload/authentication authority.
 * Lower limits support secret-free fake-child regressions, never increase production budgets.
 */
export function superviseSegmentServiceChild(
  child: ChildProcess,
  expected: Readonly<SealedSegmentReceipt>,
  options: {
    signal?: AbortSignal;
    deadlineMs?: number;
    graceMs?: number;
    rssLimitBytes?: number;
  } = {},
) {
  const deadline = options.deadlineMs ?? SERVICE_UPLOAD_DEADLINE_MS;
  const grace = options.graceMs ?? graceMs;
  const memoryLimit = options.rssLimitBytes ?? rssLimit;
  return new Promise<{
    terminated: true;
    artifact: z.infer<typeof childReply>['artifact'];
    childMaxRssKiB: number;
    sampledCombinedRssBytes: number;
    physicalHttpRequests: number;
    physicalHttpRequestLimit: z.infer<typeof childReply>['physicalHttpRequestLimit'];
  }>((resolve, reject) => {
    let failure: string | undefined,
      outputBytes = 0,
      replyBytes = 0,
      maxCombined = 0;
    let closed = false,
      sampling = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const stop = (reason: string) => {
      if (closed || failure) return;
      failure = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, grace);
    };
    const validLimits =
      Number.isSafeInteger(deadline) &&
      deadline > 0 &&
      deadline <= SERVICE_UPLOAD_DEADLINE_MS &&
      Number.isSafeInteger(grace) &&
      grace >= 0 &&
      grace <= graceMs &&
      Number.isSafeInteger(memoryLimit) &&
      memoryLimit > 0 &&
      memoryLimit <= rssLimit;
    const timeout = setTimeout(() => stop('deadline'), validLimits ? deadline : 1);
    const abort = () => stop('aborted');
    options.signal?.addEventListener('abort', abort, { once: true });
    const discard = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimit) stop('output-bound');
    };
    child.stdout?.on('data', discard);
    child.stderr?.on('data', discard);
    child.stdout?.on('error', () => stop('output-stream'));
    child.stderr?.on('error', () => stop('output-stream'));
    const channel = child.stdio[3];
    if (channel && 'on' in channel) {
      channel.on('error', () => stop('receipt-stream'));
      channel.on('data', (chunk: Buffer) => {
        replyBytes += chunk.length;
        if (replyBytes > receiptLimit) stop('receipt-bound');
        else chunks.push(Buffer.from(chunk));
      });
    }
    const sample = async () => {
      if (sampling || closed || child.pid === undefined) return;
      sampling = true;
      try {
        const status = await procStatus(child.pid);
        const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
        if (!match) throw new Error('unknown');
        const bytes = Number(match[1]) * 1024 + process.memoryUsage().rss;
        if (!Number.isSafeInteger(bytes)) throw new Error('unknown');
        maxCombined = Math.max(maxCombined, bytes);
        if (bytes > memoryLimit) stop('rss-bound');
      } catch {
        if (!closed && child.exitCode === null && child.signalCode === null) stop('rss-unknown');
      } finally {
        sampling = false;
      }
    };
    const sampler = setInterval(() => {
      void sample();
    }, 100);
    child.once('error', () => stop('spawn-error'));
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(timeout);
      clearInterval(sampler);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', abort);
      try {
        if (failure || code !== 0 || signal || !channel) throw new Error('failed');
        const reply = childReply.parse(
          JSON.parse(Buffer.concat(chunks, replyBytes).toString('utf8')),
        );
        maxCombined = Math.max(
          maxCombined,
          reply.childMaxRssKiB * 1024 + process.memoryUsage().rss,
        );
        if (
          reply.artifact.name !== expected.name ||
          reply.artifact.bytes !== expected.bytes ||
          reply.artifact.digest !== expected.digest ||
          reply.childMaxRssKiB * 1024 > memoryLimit ||
          reply.physicalHttpRequestLimit !==
            SEGMENT_SERVICE_HTTP_REQUESTS[segmentServiceUploadKind(expected.name)] ||
          reply.physicalHttpRequests > reply.physicalHttpRequestLimit
        )
          throw new Error('failed');
        if (maxCombined > memoryLimit) throw new Error('failed');
        resolve({ ...reply, terminated: true, sampledCombinedRssBytes: maxCombined });
      } catch {
        reject(
          new Error(
            `Segment service child failed (${failure ?? 'receipt-or-exit'}); allocation outcome unknown`,
          ),
        );
      }
    });
    if (!validLimits || process.platform !== 'linux') stop('unsupported-supervision');
    if (options.signal?.aborted) abort();
  });
}

/** Fixed public-SDK child only. Caller has already debited the immutable allocation.
 * No caller command, environment, or script injection. Failures never refund or retry.
 */
export async function executeSealedSegmentServiceUpload(
  path: string,
  receipt: Readonly<SealedSegmentReceipt>,
  signal?: AbortSignal,
) {
  segmentServiceReceiptSchema.parse(receipt);
  signal?.throwIfAborted();
  if (process.platform !== 'linux' || !process.versions.node.startsWith('24.'))
    throw new Error('Segment service child requires Linux Node 24');
  if (process.memoryUsage().rss >= rssLimit) throw new Error('Segment service parent RSS bound');
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'HOME',
    'TMPDIR',
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_RESULTS_URL',
    'GITHUB_WORKSPACE',
    'GITHUB_SERVER_URL',
    'GITHUB_ACTIONS',
    'GITHUB_SHA',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_ATTEMPT',
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY = '1';
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./league-segment-service-upload.ts', import.meta.url)),
      path,
      JSON.stringify(receipt),
    ],
    { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] },
  );
  return superviseSegmentServiceChild(child, receipt, signal ? { signal } : {});
}
