import { ReaderBuildSchema, type ReaderBuild } from '@fantasy/domain';
import { assertPackResponse, type PackRange } from '@fantasy/domain/spatial';
import { measureAsync } from '@fantasy/api/tooling';
import { execFileSync } from 'node:child_process';
import { OperationError } from '@fantasy/api/tooling';

export class PublicReadFailure extends OperationError {
  constructor(readonly status: number) {
    super(
      status === 401 || status === 403
        ? 'REMOTE_AUTH'
        : status === 429 || status >= 500
          ? 'REMOTE_UNAVAILABLE'
          : 'DATA_INVALID',
      `Public read-back failed (HTTP ${status})`,
    );
  }
}

export function ancestorOf(source: string, viewer: string, repository: string) {
  if (![source, viewer].every((s) => s.match(/^[a-f0-9]{40}$/)?.[0] === s))
    throw new Error('Invalid source SHA');
  try {
    try {
      execFileSync('git', ['cat-file', '-e', `${viewer}^{commit}`], {
        cwd: repository,
        stdio: 'ignore',
        timeout: 5000,
      });
    } catch {
      // Pages can advance while a long publication validates its saved graph.
      // Fetch only the observed commit; never move HEAD or accept ancestry on faith.
      execFileSync(
        'git',
        [
          'fetch',
          '--no-tags',
          '--no-recurse-submodules',
          '--no-write-fetch-head',
          'origin',
          viewer,
        ],
        {
          cwd: repository,
          stdio: 'ignore',
          timeout: 30000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        },
      );
    }
    execFileSync('git', ['merge-base', '--is-ancestor', source, viewer], {
      cwd: repository,
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
export function publicHttp(root: string, deadlineMs = 300000) {
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 14400000)
    throw new OperationError('INPUT_INVALID', 'Invalid public read-back deadline');
  let base: URL;
  try {
    base = new URL(root);
  } catch {
    throw new OperationError('INPUT_INVALID', 'Expected a public HTTPS directory URL');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new OperationError('INPUT_INVALID', 'Expected a public HTTPS directory URL');
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const deadline = AbortSignal.timeout(deadlineMs);
  let requests = 0,
    total = 0;
  let build: ReaderBuild | undefined;
  const read = async (key: string, limit: number, range?: PackRange) =>
    measureAsync('public.GET', async () => {
      if (++requests > 1002)
        throw new OperationError('BUDGET_EXCEEDED', 'Public read-back request limit');
      const url = new URL(key, base);
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
        throw new OperationError('INPUT_INVALID', 'Invalid public read-back path');
      const response = await fetch(url, {
        signal: AbortSignal.any([deadline, AbortSignal.timeout(300000)]),
        redirect: 'error',
        credentials: 'omit',
        headers: {
          accept: range
            ? 'application/octet-stream'
            : key.endsWith('.gz')
              ? 'application/gzip'
              : 'application/json',
          ...(range ? { Range: `bytes=${range.offset}-${range.offset + range.bytes - 1}` } : {}),
          'cache-control': 'no-cache',
        },
      }).catch(() => {
        throw new OperationError('REMOTE_UNAVAILABLE', 'Public read-back transport failed');
      });
      if (
        !response.ok ||
        !response.headers
          .get('content-type')
          ?.startsWith(
            range
              ? 'application/octet-stream'
              : key.endsWith('.gz')
                ? 'application/gzip'
                : 'application/json',
          ) ||
        (key.endsWith('.gz') && response.headers.has('content-encoding'))
      ) {
        await response.body?.cancel();
        throw new PublicReadFailure(response.status);
      }
      let observedBuild: ReaderBuild | undefined;
      if (range) {
        try {
          assertPackResponse(response.status, response.headers, range);
          observedBuild = ReaderBuildSchema.parse({
            sourceSha: response.headers.get('x-replay-source'),
            publicationSchema: Number(response.headers.get('x-replay-publication')),
          });
        } catch (error) {
          await response.body?.cancel();
          throw error;
        }
      }
      const reader = response.body?.getReader();
      if (!reader) throw new OperationError('DATA_INVALID', 'Public read-back body missing');
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (let part = await reader.read(); !part.done; part = await reader.read()) {
          size += part.value.length;
          total += part.value.length;
          if (size > limit)
            throw new OperationError(
              'DATA_INVALID',
              'Public read-back object exceeds declared size',
            );
          if (total > 256_000_000)
            throw new OperationError('BUDGET_EXCEEDED', 'Public read-back byte budget');
          parts.push(part.value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error instanceof OperationError
          ? error
          : new OperationError('REMOTE_UNAVAILABLE', 'Public read-back stream failed');
      } finally {
        reader.releaseLock();
      }
      if (range && size !== range.bytes)
        throw new OperationError('DATA_INVALID', 'Truncated pack range response');
      if (observedBuild) build = observedBuild;
      return Buffer.concat(parts);
    });
  return Object.assign(read, { readerBuild: () => build });
}
