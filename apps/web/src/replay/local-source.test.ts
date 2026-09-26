import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vite-plus/test';
import { replayContext, ReplayState, type ReplayManifest } from '@fantasy/domain/spatial';
import { openReplay } from './open-replay.ts';
import { ReplayPlayer } from './replay-player.ts';
import {
  exportLocalReplay,
  LOCAL_MAX_BYTES,
  localReplaySource,
  readLocalFiles,
  type LocalFile,
} from './local-source.ts';
import { readTar, writeTar } from './tar.ts';

// Fixed ReplayWriter bytes; see test-fixtures/replays/provenance.json.
const FIXTURE = new URL(
  '../../test-fixtures/replays/stage-vanguard-staged-duelist-300/',
  import.meta.url,
);
async function fixtureFiles() {
  const files = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const name of await readdir(FIXTURE))
    files.set(name, new Uint8Array(await readFile(new URL(name, FIXTURE))));
  return files;
}
/** A browser File stand-in that records whether its bytes were read. */
function file(name: string, bytes: Uint8Array<ArrayBuffer>, size = bytes.length) {
  const arrayBuffer = vi.fn<() => Promise<ArrayBuffer>>(() =>
    Promise.resolve(bytes.slice().buffer),
  );
  return { name, size, arrayBuffer } satisfies LocalFile;
}
const selection = (files: Map<string, Uint8Array<ArrayBuffer>>) =>
  [...files].map(([name, bytes]) => file(name, bytes));
const sha = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

describe('local replay files', () => {
  it('opens selected files with the #79 contract and plays to the recorded result', async () => {
    const files = await fixtureFiles();
    const local = await readLocalFiles(selection(files));
    const manifest = JSON.parse(
      Buffer.from(files.get('manifest.json')!).toString(),
    ) as ReplayManifest;
    expect(local.key).toBe(sha(files.get('manifest.json')!));
    expect(Object.keys(local.files).toSorted()).toEqual(
      [...files.keys()].filter((name) => name.endsWith('.gz')).toSorted(),
    );
    const opened = await openReplay(localReplaySource(local));
    const last = await new ReplayPlayer(opened).frame(manifest.lastVerifiedStep!);
    // Independent oracle: Node zlib and full sequential application.
    const state = new ReplayState(await replayContext(manifest.input, manifest.simulationHash));
    for (const chunk of manifest.chunks)
      for (const line of gunzipSync(files.get(chunk.file)!).toString().trimEnd().split('\n'))
        state.apply(JSON.parse(line));
    expect(last.checkpoint.step).toBe(300);
    expect(last.checkpoint.state).toEqual(state.checkpoint().state);
    expect(opened.manifest.end).toEqual(manifest.end);
  });
  it('round-trips the unchanged bytes through an exported single-file tar', async () => {
    const files = await fixtureFiles();
    const local = await readLocalFiles(selection(files));
    const tar = exportLocalReplay(local);
    expect(exportLocalReplay(local)).toEqual(tar); // deterministic
    const entries = readTar(tar, 100);
    for (const entry of entries) expect(entry.bytes).toEqual(files.get(entry.name));
    const again = await readLocalFiles([file('saved.replay.tar', tar)]);
    expect(again.key).toBe(local.key);
    expect(again.files).toEqual(local.files);
  });
  it('accepts a public bundle directory but ignores its receipt', async () => {
    const files = await fixtureFiles();
    files.set('receipt.json', new TextEncoder().encode('{"not":"trusted"}'));
    const local = await readLocalFiles(
      [...files].map(([name, bytes]) => file(`objects/abc/${name}`, bytes)),
    );
    expect(Object.keys(local.files)).not.toContain('receipt.json');
  });
  it('rejects an oversized file before reading any bytes', async () => {
    const files = await fixtureFiles();
    const chosen = selection(files);
    chosen.push(file('chunk-00099.ndjson.gz', new Uint8Array(1), 16 * 1024 * 1024 + 1));
    await expect(readLocalFiles(chosen)).rejects.toMatchObject({ kind: 'damaged' });
    for (const entry of chosen) expect(entry.arrayBuffer).not.toHaveBeenCalled();
    const huge = [file('manifest.json', new Uint8Array(1), 4_000_000)];
    for (let i = 0; i < 2; i++)
      huge.push(file(`chunk-0000${i}.ndjson.gz`, new Uint8Array(1), 16 * 1024 * 1024));
    expect(huge.reduce((sum, f) => sum + f.size, 0)).toBeGreaterThan(LOCAL_MAX_BYTES);
    await expect(readLocalFiles(huge)).rejects.toThrow(/size limit/);
    for (const entry of huge) expect(entry.arrayBuffer).not.toHaveBeenCalled();
  });
  it.each([
    [
      'a missing chunk',
      (f: Map<string, Uint8Array<ArrayBuffer>>) => f.delete('chunk-00002.ndjson.gz'),
      /missing/,
    ],
    [
      'a missing manifest',
      (f: Map<string, Uint8Array<ArrayBuffer>>) => f.delete('manifest.json'),
      /manifest.json is missing/,
    ],
    [
      'an unknown file',
      (f: Map<string, Uint8Array<ArrayBuffer>>) => f.set('notes.txt', new Uint8Array(1)),
      /Unexpected replay file/,
    ],
    [
      'an unlisted artifact',
      (f: Map<string, Uint8Array<ArrayBuffer>>) =>
        f.set('chunk-00042.ndjson.gz', new Uint8Array(1)),
      /not in the manifest/,
    ],
    [
      'changed chunk bytes',
      (f: Map<string, Uint8Array<ArrayBuffer>>) => {
        const bytes = f.get('chunk-00001.ndjson.gz')!.slice();
        bytes[20]! ^= 1;
        f.set('chunk-00001.ndjson.gz', bytes);
      },
      /size and checksum/,
    ],
    [
      'a malformed manifest',
      (f: Map<string, Uint8Array<ArrayBuffer>>) =>
        f.set('manifest.json', new TextEncoder().encode('{bad')),
      /JSON/,
    ],
  ])('rejects %s as damaged', async (_, change, message) => {
    const files = await fixtureFiles();
    change(files);
    const failure = readLocalFiles(selection(files));
    await expect(failure).rejects.toMatchObject({ kind: 'damaged' });
    await expect(failure).rejects.toThrow(message);
  });
  it('rejects an unsupported recording format and duplicate names', async () => {
    const files = await fixtureFiles();
    const manifest = JSON.parse(Buffer.from(files.get('manifest.json')!).toString()) as {
      schemaVersion: number;
    };
    files.set(
      'manifest.json',
      new TextEncoder().encode(JSON.stringify({ ...manifest, schemaVersion: 2 })),
    );
    await expect(readLocalFiles(selection(files))).rejects.toMatchObject({ kind: 'unsupported' });
    const again = await fixtureFiles();
    const chosen = selection(again);
    chosen.push(file('copy/manifest.json', again.get('manifest.json')!));
    await expect(readLocalFiles(chosen)).rejects.toThrow(/Duplicate/);
  });
});

describe('replay tar container', () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  it('rejects links, broken checksums, truncation and unsafe names', () => {
    const tar = writeTar([{ name: 'manifest.json', bytes: bytes('{}') }]);
    expect(readTar(tar, 1)).toEqual([{ name: 'manifest.json', bytes: bytes('{}') }]);
    expect(() => readTar(tar, 0)).toThrow(/too many/);
    const link = tar.slice();
    link[156] = '2'.charCodeAt(0);
    // Keep the checksum valid so the entry type itself is what is rejected.
    const sum = [...link.subarray(0, 512)].reduce(
      (total, byte, i) => total + (i >= 148 && i < 156 ? 32 : byte),
      0,
    );
    link.set(bytes(sum.toString(8).padStart(6, '0') + '\0 '), 148);
    expect(() => readTar(link, 1)).toThrow(/Unsupported tar entry type/);
    const broken = tar.slice();
    broken[0] = 'M'.charCodeAt(0) + 1;
    expect(() => readTar(broken, 1)).toThrow(/checksum/);
    expect(() => readTar(tar.slice(0, 1024), 1)).toThrow(/end marker/);
    expect(() => writeTar([{ name: '../escape', bytes: bytes('') }])).toThrow(RangeError);
  });
});
