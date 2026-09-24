import type { R2Bucket } from '@cloudflare/workers-types';
import { PublicKeySchema } from '@fantasy/domain/spatial';

export interface ReaderEnv {
  REPLAYS: Pick<R2Bucket, 'get' | 'head'>;
}
const origin = 'https://apaapapapapa.github.io';

/** Public, read-only transport. Validation is independent of CORS and never lists R2. */
export async function readReplay(request: Request, env: ReaderEnv): Promise<Response> {
  const headers = new Headers({
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Origin',
    'Access-Control-Expose-Headers': 'ETag, Content-Encoding',
    'Cache-Control': 'no-store',
  });
  const suppliedOrigin = request.headers.get('origin');
  if (suppliedOrigin === origin) headers.set('Access-Control-Allow-Origin', origin);
  const error = (status: number, code: string) => {
    headers.delete('Content-Length');
    headers.delete('ETag');
    headers.set('Cache-Control', 'no-store');
    headers.set('Content-Type', 'application/json');
    return new Response(request.method === 'HEAD' ? null : JSON.stringify({ error: code }), {
      status,
      headers,
    });
  };
  if (suppliedOrigin && suppliedOrigin !== origin) return error(403, 'origin-not-allowed');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    headers.set('Allow', 'GET, HEAD, OPTIONS');
    return error(405, 'read-only');
  }
  const url = new URL(request.url),
    key = PublicKeySchema.safeParse(url.pathname.slice(1));
  if (url.search || url.hash || !key.success) return error(404, 'invalid-public-key');
  if (request.method === 'OPTIONS') {
    if (!['GET', 'HEAD'].includes(request.headers.get('access-control-request-method') ?? 'GET'))
      return error(405, 'read-only');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Max-Age', '86400');
    return new Response(null, { status: 204, headers });
  }
  try {
    const object =
      request.method === 'HEAD'
        ? await env.REPLAYS.head(key.data)
        : await env.REPLAYS.get(key.data);
    if (!object) return error(404, 'not-published');
    headers.set('Content-Type', key.data.endsWith('.gz') ? 'application/gzip' : 'application/json');
    headers.set(
      'Cache-Control',
      key.data === 'catalog/current.json'
        ? 'public, max-age=30, no-transform'
        : 'public, max-age=31536000, immutable, no-transform',
    );
    headers.set('ETag', object.httpEtag);
    headers.set('Content-Length', String(object.size));
    // Workers streams implement the web stream contract, with additional CF type extensions.
    const body = 'body' in object ? (object.body as unknown as ReadableStream<Uint8Array>) : null;
    return new Response(body, { headers });
  } catch {
    return error(503, 'storage-unavailable');
  }
}
export default { fetch: readReplay };
