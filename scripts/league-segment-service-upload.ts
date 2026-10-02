import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SEGMENT_SERVICE_HTTP_REQUESTS,
  SEGMENT_SERVICE_UPLOAD_NAME,
  segmentServiceUploadKind,
  type SegmentServiceUploadKind,
} from './league-segment-service-bounds.ts';
let guarded = false;
/** Restriction only, installed before any third-party dependency can snapshot core transports.
 * Counts request creations conservatively (including requests cancelled before wire transmission).
 * Exhaustion terminates the one-shot child; SDK retry cannot create request upper+1.
 */
export function installSegmentPhysicalHttpGuard(kind: SegmentServiceUploadKind) {
  if (guarded || !['data', 'metrics'].includes(kind)) throw new Error('Invalid child HTTP guard');
  guarded = true;
  const upper = SEGMENT_SERVICE_HTTP_REQUESTS[kind];
  let actual = 0;
  const terminate = () => {
    process.kill(process.pid, 'SIGTERM');
    process.exit(1);
  };
  const debit = () => {
    if (actual >= upper) {
      terminate(); // Also stops SDK retry if a dependency installed a SIGTERM handler.
    }
    actual++;
  };
  for (const transport of [http, https]) {
    for (const key of ['request', 'get'] as const) {
      Object.defineProperty(transport, key, {
        configurable: true,
        writable: true,
        value: new Proxy(transport[key], {
          apply(target, receiver, args) {
            debit();
            return Reflect.apply(target, receiver, args);
          },
        }),
      });
    }
  }
  globalThis.fetch = new Proxy(globalThis.fetch, {
    apply() {
      return terminate();
    },
  });
  syncBuiltinESMExports();
  return { snapshot: () => ({ physicalHttpRequests: actual, physicalHttpRequestLimit: upper }) };
}

/** Fixed child entry: public SDK upload, no alternate command/service/retry implementation.
 * Parent owns deadline, kill/drain, allocation ledger and authenticated REST readback.
 */
async function upload() {
  if (
    process.platform !== 'linux' ||
    !process.versions.node.startsWith('24.') ||
    process.argv.length !== 4 ||
    process.env.ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY !== '1'
  )
    throw new Error('Invalid child environment');
  const path = resolve(process.argv[2]!);
  if (
    [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'NO_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
      'no_proxy',
    ].some((key) => process.env[key] !== undefined)
  )
    throw new Error('Child proxy environment forbidden');
  const raw = JSON.parse(process.argv[3]!) as { name?: unknown };
  if (typeof raw.name !== 'string' || !SEGMENT_SERVICE_UPLOAD_NAME.test(raw.name))
    throw new Error('Invalid child name');
  const guard = installSegmentPhysicalHttpGuard(segmentServiceUploadKind(raw.name));
  // Literal owner imports occur only after the core HTTP guard is active.
  const { segmentServiceReceiptSchema } = await import('./league-segment-service-executor.ts');
  const { segmentV3Hash } = await import('./league-segment-v3.ts');
  const { readBoundedFile } = await import('@fantasy/api/artifacts');
  const receipt = segmentServiceReceiptSchema.parse(JSON.parse(process.argv[3]!));
  const prefix = `league-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}-`;
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_SHA !== receipt.sourceSha ||
    !receipt.name.startsWith(prefix) ||
    basename(path) !== receipt.name ||
    !basename(dirname(path)).startsWith('.sealed-segment-') ||
    (await realpath(path)) !== path
  )
    throw new Error('Foreign child source/path');
  const parent = await lstat(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (parent.mode & 0o077) !== 0 ||
    parent.uid !== process.getuid?.()
  )
    throw new Error('Unowned child staging');
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    (before.mode & 0o222) !== 0 ||
    before.uid !== parent.uid ||
    before.size !== receipt.bytes
  )
    throw new Error('Unsealed child file');
  const bytes = await readBoundedFile(path, receipt.bytes);
  if (segmentV3Hash(bytes) !== receipt.digest) throw new Error('Child seal digest mismatch');
  const sdkRoot = dirname(fileURLToPath(import.meta.resolve('@actions/artifact')));
  const sdk = JSON.parse(await readFile(resolve(sdkRoot, '../package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (sdk.version !== '6.2.1') throw new Error('Unreviewed child SDK');
  const { default: artifact } = await import('@actions/artifact');
  const result = await artifact.uploadArtifact(receipt.name, [path], dirname(path), {
    skipArchive: true,
    retentionDays: 1,
  });
  const after = await lstat(path);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    (after.mode & 0o222) !== 0 ||
    after.ino !== before.ino ||
    after.dev !== before.dev ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    segmentV3Hash(await readBoundedFile(path, receipt.bytes)) !== receipt.digest ||
    !Number.isSafeInteger(result.id) ||
    result.id! < 1 ||
    result.size !== receipt.bytes ||
    `sha256:${result.digest}` !== receipt.digest
  )
    throw new Error('Child upload/seal changed');
  writeSync(
    3,
    JSON.stringify({
      artifact: { id: result.id, name: receipt.name, bytes: result.size, digest: receipt.digest },
      childMaxRssKiB: process.resourceUsage().maxRSS,
      ...guard.snapshot(),
    }),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void upload().catch(() => {
    // SDK failures may contain signed URLs/tokens. Never serialize or print the exception.
    process.exitCode = 1;
  });
}
