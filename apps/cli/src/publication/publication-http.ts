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
  if (![source, viewer].every((s) => /^[a-f0-9]{40}$/.test(s)))
    throw new Error('Invalid source SHA');
  try {
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
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 7200000)
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
  return async (key: string, limit: number) => {
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
        accept: key.endsWith('.gz') ? 'application/gzip' : 'application/json',
        'cache-control': 'no-cache',
      },
    }).catch(() => {
      throw new OperationError('REMOTE_UNAVAILABLE', 'Public read-back transport failed');
    });
    if (
      !response.ok ||
      !response.headers
        .get('content-type')
        ?.startsWith(key.endsWith('.gz') ? 'application/gzip' : 'application/json') ||
      (key.endsWith('.gz') && response.headers.has('content-encoding'))
    ) {
      await response.body?.cancel();
      throw new PublicReadFailure(response.status);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new OperationError('DATA_INVALID', 'Public read-back body missing');
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (let part = await reader.read(); !part.done; part = await reader.read()) {
        size += part.value.length;
        total += part.value.length;
        if (size > limit || total > 256_000_000)
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
    return Buffer.concat(parts);
  };
}
