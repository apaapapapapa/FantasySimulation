import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  canonicalJson,
  LeagueCloudPreparedSchema,
  LeagueCloudInputSchema,
  type LeagueFileRef,
  type LeagueCloudPrepared,
} from '@fantasy/domain/spatial';
import { readBoundedFile, publishImmutableFile, sha256 } from '@fantasy/api/artifacts';
import { publicationDirectory } from '../publication/publication-files.ts';

export async function cloudJson(path: string, ref?: LeagueFileRef): Promise<unknown> {
  await publicationDirectory(dirname(path));
  const data = await readBoundedFile(path, ref?.bytes ?? 16000000);
  if (ref && (data.length !== ref.bytes || sha256(data) !== ref.hash))
    throw new Error('League cloud file checksum mismatch');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
}
export async function writeCloudJson(path: string, value: unknown) {
  await publicationDirectory(dirname(path), true);
  const data = Buffer.from(canonicalJson(value));
  if (data.length > 16000000) throw new Error('League cloud document size limit');
  await publishImmutableFile(path, data);
  return { hash: sha256(data), bytes: data.length };
}
export const preparedLeague = async (root: string) =>
  LeagueCloudPreparedSchema.parse(await cloudJson(join(root, 'prepared.json')));
export async function cloudInput(root: string, prepared: LeagueCloudPrepared, index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= prepared.inputs.length)
    throw new Error('Invalid league cloud partition');
  return LeagueCloudInputSchema.parse(
    await cloudJson(join(root, 'inputs', String(index), 'input.json'), prepared.inputs[index]!),
  );
}
export async function newCloudDirectory(root: string) {
  await publicationDirectory(dirname(root), true);
  await mkdir(root);
}
