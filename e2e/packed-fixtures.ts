import { createHash } from 'node:crypto';
import { canonicalJson, type PackEntry } from '@fantasy/domain/spatial';
import { selectionFiles, selectionGenerations, selectionUrl } from './selection-fixtures.ts';

/** Independent fixture assembly preserves the pinned historical payload, IDs and expectations. */
export function packedFixture() {
  const generation = selectionGenerations[0]!;
  const files = new Map(selectionFiles);
  const hash = (data: Buffer) => 'sha256:' + createHash('sha256').update(data).digest('hex');
  const add = (prefix: string, value: unknown) => {
    const bytes = Buffer.from(canonicalJson(value)),
      checksum = hash(bytes);
    files.set(prefix + checksum.slice(7) + '.json', bytes);
    return { hash: checksum, bytes: bytes.length };
  };
  const objects = new Set(generation.rows.map((row) => row.replay!.objectHash.slice(7)));
  const entries: PackEntry[] = [],
    parts: Buffer[] = [];
  let offset = 0;
  for (const [key, data] of [...files]
    .filter(([key]) => key.startsWith('objects/') && objects.has(key.split('/')[1]!))
    .sort(([a], [b]) => a.localeCompare(b))) {
    const manifest: {
      chunks: { file: string; rawBytes: number }[];
      checkpoints: { file: string; rawBytes: number }[];
    } = JSON.parse(files.get(key.slice(0, 73) + 'manifest.json')!.toString('utf8'));
    const ref = [...manifest.chunks, ...manifest.checkpoints].find((ref) =>
      key.endsWith('/' + ref.file),
    );
    entries.push({
      key,
      offset,
      bytes: data.length,
      checksum: hash(data),
      encoding: ref ? 'gzip' : 'identity',
      rawBytes: ref?.rawBytes ?? data.length,
    });
    parts.push(data);
    offset += data.length;
  }
  const data = Buffer.concat(parts),
    packHash = hash(data),
    packPath = `packs/${packHash.slice(7)}.bin`;
  files.set(packPath, data);
  const index = { schemaVersion: 1, packHash, packBytes: data.length, entries },
    indexRef = add('pack-indexes/', index);
  const rows = generation.rows.map((row) => ({
    ...row,
    replay: { ...row.replay!, packs: [indexRef] },
  }));
  const prior: { planId: string; pages: unknown } = JSON.parse(
    files.get(`sets/${generation.setHash.slice(7)}/set.json`)!.toString('utf8'),
  );
  const page = Buffer.from(
      canonicalJson({ schemaVersion: 2, planId: prior.planId, index: 0, rows }),
    ),
    pageHash = hash(page);
  const set = Buffer.from(
      canonicalJson({
        ...prior,
        schemaVersion: 2,
        pages: [{ index: 0, pageHash, bytes: page.length, rows: rows.length }],
      }),
    ),
    setHash = hash(set);
  files.set(`sets/${setHash.slice(7)}/set.json`, set);
  files.set(`sets/${setHash.slice(7)}/${pageHash.slice(7)}.json`, page);
  const catalog = add('catalog/', {
    schemaVersion: 2,
    previousCatalogHash: null,
    sets: [{ setHash, bytes: set.length }],
  });
  files.set(
    'catalog/current.json',
    Buffer.from(
      canonicalJson({ schemaVersion: 2, catalogHash: catalog.hash, bytes: catalog.bytes }),
    ),
  );
  return { files, rows, index, indexRef, packPath, setHash, url: selectionUrl(setHash) };
}
export function packedResponse(
  files: ReadonlyMap<string, Buffer>,
  key: string,
  range: string | null,
) {
  const data = files.get(key),
    match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
  const packed = key.startsWith('packs/');
  const start = Number(match?.[1]),
    end = Number(match?.[2]);
  const ok = data && (!packed || (match && end < data.length && start <= end));
  const body = ok ? (packed ? data.subarray(start, end + 1) : data) : Buffer.alloc(0);
  return {
    status: !data ? 404 : !ok ? 416 : packed ? 206 : 200,
    body,
    headers: {
      'content-type': packed
        ? 'application/octet-stream'
        : key.endsWith('.gz')
          ? 'application/gzip'
          : 'application/json',
      'access-control-allow-origin': '*',
      'content-length': String(body.length),
      ...(packed && ok
        ? {
            'content-range': `bytes ${start}-${end}/${data.length}`,
            'accept-ranges': 'bytes',
            etag: '"fixture-pack"',
          }
        : {}),
    },
  };
}
