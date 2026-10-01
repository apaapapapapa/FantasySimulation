import { z } from 'zod';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readBoundedFile, sha256, OperationError } from '@fantasy/api/artifacts';
import {
  canonicalJson,
  HashSchema,
  PublicKeySchema,
  LeaguePipelineIdentitySchema,
  LeagueProducerArtifactSchema,
  LeagueProducerProofSchema,
} from '@fantasy/domain/spatial';
import type { PipelineIdentity } from './league-producer.ts';
import { publicationDirectory } from '../publication/publication-files.ts';
import { dirname } from 'node:path';

export const PACKED_RAW_BYTES = 48 * 1024 ** 2;
export const PACKED_INDEX_BYTES = 65536;
export class PackedCapacityError extends Error {}
const partition = z.number().int().min(0).max(63);
export function packedPath(key: string) {
  if (key === 'index.json') return true;
  const match = /^partitions\/(\d+)\/(.+)$/.exec(key);
  if (!match || String(Number(match[1])) !== match[1] || Number(match[1]) > 63) return false;
  return (
    ['proof.json', 'result.json'].includes(match[2]!) ||
    (match[2]!.startsWith('public/') && PublicKeySchema.safeParse(match[2]!.slice(7)).success)
  );
}
const entry = z.strictObject({
  path: z
    .string()
    .max(512)
    .refine((key) => key !== 'index.json' && packedPath(key)),
  bytes: z.number().int().min(1).max(PACKED_RAW_BYTES),
  checksum: HashSchema,
});
const descriptor = z.strictObject({
  partition,
  proofHash: HashSchema,
  resultHash: HashSchema,
  files: z.array(entry).min(3).max(4098),
});
const indexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  identity: LeaguePipelineIdentitySchema,
  runner: z.number().int().min(0).max(31),
  group: z.number().int().min(0).max(29),
  partitions: z.array(descriptor).min(1).max(2),
});
export type PackedDescriptor = z.infer<typeof descriptor>;
export type PackedIndex = z.infer<typeof indexSchema>;
type Artifact = z.infer<typeof LeagueProducerArtifactSchema>;
export function packedArtifactName(identity: PipelineIdentity, runner: number, group: number) {
  return `league-${identity.runId}-${identity.runAttempt}-runner-${runner}-pack-${group}`;
}
export function packedIndex(
  identity: PipelineIdentity,
  runner: number,
  group: number,
  partitions: PackedDescriptor[],
) {
  const index = indexSchema.parse({ schemaVersion: 1, identity, runner, group, partitions });
  const paths = index.partitions.flatMap((p) => p.files.map((f) => f.path));
  if (
    new Set(index.partitions.map((p) => p.partition)).size !== index.partitions.length ||
    new Set(paths).size !== paths.length ||
    index.partitions.some((p) =>
      p.files.some((f) => !f.path.startsWith(`partitions/${p.partition}/`)),
    )
  )
    throw new Error('Packed partition/path coverage mismatch');
  const indexBytes = Buffer.byteLength(canonicalJson(index));
  if (
    indexBytes > PACKED_INDEX_BYTES ||
    indexBytes + index.partitions.flatMap((p) => p.files).reduce((n, f) => n + f.bytes, 0) >
      PACKED_RAW_BYTES
  )
    throw new PackedCapacityError('Packed index/raw-byte bound');
  return index;
}
async function checksum(path: string, bytes: number) {
  const info = await lstat(path);
  if (!info.isFile() || info.size !== bytes) throw new Error('Packed entry type/size mismatch');
  const hash = createHash('sha256');
  let actual = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) {
    actual += chunk.length;
    if (actual > bytes) throw new Error('Packed entry grew');
    hash.update(chunk);
  }
  if (actual !== bytes) throw new Error('Packed entry truncated');
  return 'sha256:' + hash.digest('hex');
}
export async function packedProducerDescriptor(
  root: string,
  proofValue: unknown,
): Promise<PackedDescriptor> {
  const proof = LeagueProducerProofSchema.parse(proofValue);
  const controls = await Promise.all(
    ['proof.json', 'result.json'].map(async (name) => {
      await publicationDirectory(root);
      const data = await readBoundedFile(join(root, name), 16 * 1024 ** 2);
      return {
        path: `partitions/${proof.partition}/${name}`,
        bytes: data.length,
        checksum: sha256(data),
      };
    }),
  );
  const files = [];
  for (const file of proof.files) {
    const path = join(root, 'public', file.key);
    await publicationDirectory(dirname(path));
    if ((await checksum(path, file.bytes)) !== file.checksum)
      throw new Error('Packed producer file changed');
    files.push({
      path: `partitions/${proof.partition}/public/${file.key}`,
      bytes: file.bytes,
      checksum: file.checksum,
    });
  }
  return descriptor.parse({
    partition: proof.partition,
    proofHash: controls[0]!.checksum,
    resultHash: controls[1]!.checksum,
    files: [...controls, ...files],
  });
}

/** A private process-local witness: never deserialize claimed successful packed validation. */
export type PackedBinding = Readonly<{
  artifact: Readonly<Artifact>;
  partitions: readonly number[];
}>;
const witnesses = new WeakMap<
  PackedBinding,
  { root: string; index: PackedIndex; indexHash: string }
>();
export async function authenticatePackedGroup(
  root: string,
  artifactValue: unknown,
  identity: PipelineIdentity,
  runner: number,
  allowed: readonly number[],
): Promise<PackedBinding> {
  await publicationDirectory(root);
  const artifact = LeagueProducerArtifactSchema.parse(artifactValue);
  const raw = await readBoundedFile(join(root, 'index.json'), PACKED_INDEX_BYTES);
  const value = indexSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
  );
  const index = packedIndex(value.identity, value.runner, value.group, value.partitions);
  if (
    canonicalJson(index.identity) !== canonicalJson(identity) ||
    index.runner !== runner ||
    artifact.name !== packedArtifactName(identity, runner, index.group) ||
    index.partitions.some((p) => !allowed.includes(p.partition))
  )
    throw new Error('Packed execution/assignment mismatch');
  const expected = new Map(index.partitions.flatMap((p) => p.files).map((f) => [f.path, f]));
  const seen = new Set<string>();
  let entries = 0,
    total = raw.length;
  async function walk(directory: string, prefix: string) {
    if (!(await lstat(directory)).isDirectory()) throw new Error('Packed directory type mismatch');
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (++entries > 16384) throw new Error('Packed entry-count bound');
      const key = prefix + item.name,
        path = join(directory, item.name);
      if (item.isDirectory()) {
        if (![...expected.keys()].some((name) => name.startsWith(key + '/')))
          throw new Error('Unexpected packed directory');
        await walk(path, key + '/');
      } else if (item.isFile()) {
        if (key === 'index.json') continue;
        const file = expected.get(key);
        if (!file || seen.has(key)) throw new Error('Unexpected packed entry');
        total += file.bytes;
        if (total > PACKED_RAW_BYTES || (await checksum(path, file.bytes)) !== file.checksum)
          throw new Error('Packed entry checksum/raw-byte mismatch');
        seen.add(key);
      } else throw new Error('Packed entry symlink/type mismatch');
    }
  }
  await walk(root, '');
  if (
    seen.size !== expected.size ||
    index.partitions.some(
      (p) =>
        expected.get(`partitions/${p.partition}/proof.json`)?.checksum !== p.proofHash ||
        expected.get(`partitions/${p.partition}/result.json`)?.checksum !== p.resultHash,
    )
  )
    throw new Error('Packed controls/entry coverage mismatch');
  const binding = Object.freeze({
    artifact: Object.freeze(artifact),
    partitions: Object.freeze(index.partitions.map((p) => p.partition)),
  });
  witnesses.set(binding, { root: resolve(root), index, indexHash: sha256(raw) });
  return binding;
}
export async function packedPartitionArtifact(
  binding: PackedBinding,
  root: string,
  partitionIndex: number,
  identity: PipelineIdentity,
  runner: number,
) {
  const witness = witnesses.get(binding),
    entry = witness?.index.partitions.find((p) => p.partition === partitionIndex);
  if (
    !witness ||
    !entry ||
    resolve(root) !== resolve(witness.root, 'partitions', String(partitionIndex)) ||
    canonicalJson(witness.index.identity) !== canonicalJson(identity) ||
    witness.index.runner !== runner
  )
    throw new Error('Unverified packed partition binding');
  if (
    sha256(await readBoundedFile(join(witness.root, 'index.json'), PACKED_INDEX_BYTES)) !==
      witness.indexHash ||
    sha256(await readBoundedFile(join(root, 'proof.json'), 16 * 1024 ** 2)) !== entry.proofHash ||
    sha256(await readBoundedFile(join(root, 'result.json'), 16 * 1024 ** 2)) !== entry.resultHash
  )
    throw new Error('Packed controls changed after validation');
  return binding.artifact;
}
export function packedBindingCoverage(
  binding: PackedBinding,
  identity: PipelineIdentity,
  runner: number,
) {
  const witness = witnesses.get(binding);
  if (
    !witness ||
    canonicalJson(witness.index.identity) !== canonicalJson(identity) ||
    witness.index.runner !== runner
  )
    throw new Error('Unverified packed terminal binding');
  return { artifact: binding.artifact, partitions: binding.partitions };
}

/** Sharing is legal only for every partition of the same authenticated packed group. */
export function uniqueProducerArtifacts(
  producers: readonly {
    proof: { runner: number; partition: number };
    artifacts: readonly Artifact[];
    packed?: PackedBinding;
  }[],
  identity: PipelineIdentity,
) {
  const refs = new Map<number, Artifact>(),
    owners = new Map<number, PackedBinding | undefined>();
  const groups = new Map<PackedBinding, number[]>();
  for (const producer of producers) {
    if (producer.packed) {
      const coverage = packedBindingCoverage(producer.packed, identity, producer.proof.runner);
      if (
        canonicalJson(producer.artifacts) !== canonicalJson([coverage.artifact]) ||
        !coverage.partitions.includes(producer.proof.partition)
      )
        throw new Error('Packed producer artifact/partition mismatch');
      const partitions = groups.get(producer.packed) ?? [];
      partitions.push(producer.proof.partition);
      groups.set(producer.packed, partitions);
    }
    for (const artifact of producer.artifacts) {
      if (
        refs.has(artifact.id) &&
        (!producer.packed ||
          owners.get(artifact.id) !== producer.packed ||
          canonicalJson(refs.get(artifact.id)) !== canonicalJson(artifact))
      )
        throw new OperationError('DATA_INVALID', 'Duplicate producer artifact');
      refs.set(artifact.id, artifact);
      owners.set(artifact.id, producer.packed);
    }
  }
  for (const [binding, partitions] of groups)
    if (
      new Set(partitions).size !== partitions.length ||
      canonicalJson([...partitions].sort((a, b) => a - b)) !==
        canonicalJson([...binding.partitions].sort((a, b) => a - b))
    )
      throw new Error('Incomplete packed producer coverage');
  return [...refs.values()];
}
