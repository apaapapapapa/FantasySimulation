import { readBounded, strictText } from './replay/artifacts.ts';
import { RevisionPageSchema, type Revision, type RevisionRef } from '@fantasy/domain/spatial';

/** All editor requests stay on the local API origin and validate the returned contract. */
export async function api<T>(
  path: string,
  schema: { parse(value: unknown): T },
  options: {
    method?: 'POST' | 'PATCH';
    body?: unknown;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    maxBytes?: number;
  } = {},
): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    method: options.method ?? 'GET',
    signal: options.signal ?? null,
    headers: {
      accept: 'application/json',
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...options.headers,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const bytes = await readBounded(
    response.body ?? new Blob().stream(),
    options.maxBytes ?? 1024 * 1024,
    'API response',
  );
  let value: unknown;
  try {
    value = JSON.parse(strictText(bytes, 'API response'));
  } catch {
    throw new Error(`API ${response.status}: 応答を読み取れません`);
  }
  if (!response.ok) {
    const detail =
      value && typeof value === 'object' && 'error' in value && typeof value.error === 'string'
        ? value.error
        : 'リクエストに失敗しました';
    throw new Error(`API ${response.status}: ${detail}`);
  }
  try {
    return schema.parse(value);
  } catch {
    throw new Error('APIの応答形式が一致しません');
  }
}

export const jsonText = (value: unknown) => JSON.stringify(value, null, 2);
export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '操作に失敗しました';
export const reference = ({ id, revision, contentHash }: Revision): RevisionRef => ({
  id,
  revision,
  contentHash,
});

/** At most ten 512-KiB API definitions plus revision envelopes per request. */
export const apiRevisionPage = (kind: string, cursor: string | null, signal?: AbortSignal) =>
  api(
    `revisions/${kind}?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    RevisionPageSchema,
    { ...(signal ? { signal } : {}), maxBytes: 6 * 1024 * 1024 },
  );
