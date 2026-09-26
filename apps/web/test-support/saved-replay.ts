import { readFile } from 'node:fs/promises';
import { openReplay } from '../src/replay/open-replay.ts';

/** Fixed ReplayWriter bytes; the viewer never executes their saved engine. */
export function savedReplay(name: string) {
  const fixture = new URL(`../test-fixtures/replays/${name}/`, import.meta.url);
  return openReplay({
    manifest: async () => JSON.parse(await readFile(new URL('manifest.json', fixture), 'utf8')),
    file: async (ref) => new Uint8Array(await readFile(new URL(ref.file, fixture))),
  });
}
