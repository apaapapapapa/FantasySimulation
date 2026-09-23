import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ReplayManifestSchema } from '../packages/domain/src/spatial/index.ts';
import { localOrigin } from './contract.ts';

/** Saved display artifacts only: this server has no API, SQLite or engine imports.
 * #81 catalog/set/page files will be added through its shared schemas after that contract lands.
 */
export async function startStaticFixtures(root: string, viewerOrigin: string) {
  const origin = localOrigin(viewerOrigin);
  const directory = join(root, 'apps/web/test-fixtures/replays/swordsman-sky-mage-240');
  const manifest: unknown = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  ReplayManifestSchema.parse(manifest);
  const entries = readdirSync(directory).filter((name) =>
    /^(?:manifest\.json|(?:chunk|checkpoint)-\d{5}\.(?:ndjson|json)\.gz)$/.test(name),
  );
  const files = new Map(
    entries.map((name) => [`/fixtures/${name}`, readFileSync(join(directory, name))]),
  );
  const server = createServer((request, response) => {
    const bytes = files.get(request.url ?? '');
    if (!['GET', 'HEAD'].includes(request.method ?? '') || !bytes) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
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
