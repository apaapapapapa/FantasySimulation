import { gunzipSync } from 'node:zlib';
import {
  PublicMatchPageSchema,
  ReplayManifestSchema,
  StreamRecordSchema,
  publicHashName,
} from '@fantasy/domain/spatial';
import { publicFixtures } from '../publication-fixtures.ts';

export const files = publicFixtures(process.cwd());
const pages = [...files]
  .filter(([key]) => key.startsWith('sets/') && !key.endsWith('/set.json'))
  .map(([key, value]) => ({
    key,
    page: PublicMatchPageSchema.parse(JSON.parse(value.toString())),
  }));
export function match(state: 'complete' | 'truncated' | 'unresolved') {
  for (const { key, page } of pages) {
    const row = page.rows.find((row) => row.state === state);
    if (row?.replay) {
      const setHash = `sha256:${key.split('/')[1]}`;
      const prefix = `objects/${publicHashName(row.replay.objectHash)}/`;
      const manifest = ReplayManifestSchema.parse(
        JSON.parse(files.get(prefix + 'manifest.json')!.toString()),
      );
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
