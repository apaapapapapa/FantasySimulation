import { gunzipSync } from 'node:zlib';
import {
  PublicMatchPageSchema,
  ReplayManifestSchema,
  StreamRecordSchema,
  publicHashName,
} from '@fantasy/domain/spatial';
import { publicFixtures } from '../publication-fixtures.ts';
import type { BrowserContext } from '@playwright/test';

export async function serveFixture(
  context: BrowserContext,
  archive: ReadonlyMap<string, Buffer>,
  received: (key: string, bytes: number) => void = () => {},
) {
  await context.route('**/fixtures/**', async (route) => {
    const key = new URL(route.request().url()).pathname.split('/fixtures/')[1]!;
    const body = archive.get(key);
    received(key, body?.byteLength ?? 0);
    await route.fulfill({
      status: body ? 200 : 404,
      body: body ?? '',
      headers: {
        'content-type': key.endsWith('.gz') ? 'application/gzip' : 'application/json',
        'access-control-allow-origin': '*',
      },
    });
  });
}

export const files = publicFixtures(process.cwd());
export function match(
  state: 'complete' | 'truncated' | 'unresolved',
  archive = files,
  accept: (manifest: ReturnType<typeof ReplayManifestSchema.parse>) => boolean = () => true,
) {
  const pages = [...archive]
    .filter(([key]) => key.startsWith('sets/') && !key.endsWith('/set.json'))
    .map(([key, value]) => ({
      key,
      page: PublicMatchPageSchema.parse(JSON.parse(value.toString())),
    }));
  for (const { key, page } of pages) {
    const row = page.rows.find((row) => row.state === state);
    if (row?.replay) {
      const setHash = `sha256:${key.split('/')[1]}`;
      const prefix = `objects/${publicHashName(row.replay.objectHash)}/`;
      const manifest = ReplayManifestSchema.parse(
        JSON.parse(archive.get(prefix + 'manifest.json')!.toString()),
      );
      if (!accept(manifest)) continue;
      return {
        row,
        setHash,
        prefix,
        manifest,
        page: page.index,
        url: `/FantasySimulation/#/sets/${publicHashName(setHash)}/pages/${page.index}/matches/${publicHashName(row.slotId)}`,
      };
    }
  }
  throw new Error('Missing fixed fixture');
}
export const complete = match('complete');
export const event = complete.manifest.chunks
  .flatMap((chunk) =>
    gunzipSync(files.get(complete.prefix + chunk.file)!)
      .toString()
      .trim()
      .split('\n')
      .flatMap((line) => {
        const record = StreamRecordSchema.parse(JSON.parse(line));
        return 'events' in record ? record.events : [];
      }),
  )
  .find((event) => event.step > 0)!;
