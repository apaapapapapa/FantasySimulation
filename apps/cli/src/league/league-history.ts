import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  contentHash,
  LeagueProgressPageSchema,
  LeagueReservationSchema,
  LeaguePartitionResultSchema,
  type LeagueProgress,
} from '@fantasy/domain/spatial';
import { readBoundedFile } from '@fantasy/api/artifacts';
import { validateProgressPage } from '@fantasy/api/tooling';

/** Accept the actual plan/reserve/run artifacts, without manual JSON extraction. */
export async function readLeagueHistory(path?: string) {
  const records: LeagueProgress[] = [];
  if (!path) return records;
  const root = resolve(path),
    info = await lstat(root);
  const files = info.isFile()
    ? [root]
    : info.isDirectory()
      ? (await readdir(root)).sort().map((file) => {
          if (!/^[0-9a-f]{64}[.]json$/.test(file))
            throw new Error('History contains an unexpected file');
          return join(root, file);
        })
      : [];
  if (!info.isFile() && !info.isDirectory()) throw new Error('Invalid history path');
  for (const file of files) {
    const input: unknown = JSON.parse((await readBoundedFile(file, 4_000_000)).toString('utf8'));
    const parsed = LeagueProgressPageSchema.safeParse(input);
    const envelope = parsed.success
      ? parsed.data
      : LeagueReservationSchema.safeParse(input).success
        ? LeagueReservationSchema.parse(input)
        : LeaguePartitionResultSchema.parse(input);
    const { id, ...body } = envelope;
    if (
      id !== (await contentHash(body)) ||
      (!info.isFile() && file !== join(root, id.slice(7) + '.json'))
    )
      throw new Error('History checksum or filename mismatch');
    const page = await validateProgressPage('progress' in envelope ? envelope.progress : envelope);
    records.push(...page.records);
    if (records.length > 64000) throw new Error('History exceeds league slot limit');
  }
  return records;
}
