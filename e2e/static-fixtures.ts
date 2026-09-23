import { createServer } from 'node:http';
import { localOrigin } from './contract.ts';
import { publicFixtures } from './publication-fixtures.ts';

/** Read-only published fixtures; no API, SQLite or engine imports. */
export async function startStaticFixtures(root: string, viewerOrigin: () => string | null) {
  const files = publicFixtures(root);
  const server = createServer((request, response) => {
    const bytes = request.url?.startsWith('/fixtures/')
      ? files.get(request.url.slice('/fixtures/'.length))
      : undefined;
    if (!['GET', 'HEAD'].includes(request.method ?? '') || !bytes) {
      response.writeHead(404).end();
      return;
    }
    const origin = viewerOrigin();
    if (origin) response.setHeader('Access-Control-Allow-Origin', localOrigin(origin));
    response.setHeader('Vary', 'Origin');
    response.setHeader(
      'Content-Type',
      request.url?.endsWith('.gz') ? 'application/gzip' : 'application/json',
    );
    response.setHeader('Content-Length', bytes.length);
    response.writeHead(200).end(request.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static fixture did not bind');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
