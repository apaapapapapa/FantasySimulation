import { expect, it } from 'vite-plus/test';
import { cp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { withReplayDirectory } from '@fantasy/api/testing';
import { canonicalJson } from '@fantasy/domain/spatial';
import { pipelineFixture, sealedTwoPartitionFixture } from '../../test-support/league-pipeline.ts';
import { cloudInput, writeCloudJson } from './league-cloud-files.ts';
import {
  authenticatePackedLeagueProducer,
  authenticateLeagueProducer,
  type LeagueProducer,
} from './league-producer.ts';
import { finalizeLeaguePipeline } from './league-finalizer.ts';
import {
  packedProducerDescriptor,
  packedIndex,
  authenticatePackedGroup,
  packedArtifactName,
  packedPartitionArtifact,
  uniqueProducerArtifacts,
  type PackedDescriptor,
} from './league-producer-transport.ts';

async function groupFixture(root: string) {
  const fixture = await pipelineFixture(root),
    packedRoot = join(root, 'packed');
  await cp(fixture.producerRoot, join(packedRoot, 'partitions/0'), { recursive: true });
  const descriptor = await packedProducerDescriptor(fixture.producerRoot, fixture.producer.proof);
  const index = packedIndex(fixture.identity, 0, 0, [descriptor]);
  await writeCloudJson(join(packedRoot, 'index.json'), index);
  // Transport validator assumes the caller already authenticated the actual immutable ZIP.
  const artifact = {
    ...fixture.producer.artifacts[0]!,
    name: packedArtifactName(fixture.identity, 0, 0),
  };
  return { ...fixture, packedRoot, descriptor, index, artifact };
}
it('keeps legacy authentication and packed single-partition finalization equivalent', async () => {
  await withReplayDirectory(async (root) => {
    const f = await groupFixture(root);
    await expect(
      authenticateLeagueProducer(
        join(f.packedRoot, 'partitions/0'),
        f.input,
        f.identity,
        0,
        async () => [f.artifact],
      ),
    ).rejects.toThrow('identity');
    const binding = await authenticatePackedGroup(f.packedRoot, f.artifact, f.identity, 0, [0]);
    const producer = await authenticatePackedLeagueProducer(
      join(f.packedRoot, 'partitions/0'),
      f.input,
      f.identity,
      0,
      binding,
    );
    expect(producer.proof).toEqual(f.producer.proof);
    const terminal = { ...f.terminal, artifacts: [f.artifact] };
    const result = await finalizeLeaguePipeline(
      f.preparedRoot,
      join(root, 'final'),
      [producer],
      [terminal],
      f.identity,
      1,
      async () => {},
      f.baseline,
    );
    expect(result).toMatchObject({ status: 'formal', planned: 4, resolved: 4 });
    await expect(
      packedPartitionArtifact({ ...binding }, join(f.packedRoot, 'partitions/0'), 0, f.identity, 0),
    ).rejects.toThrow('Unverified');
  });
});
it('rejects missing, extra, corrupt, foreign and mutated packed claims with fresh validation', async () => {
  await withReplayDirectory(async (root) => {
    const f = await groupFixture(root);
    for (const variant of [
      'missing',
      'extra',
      'proof',
      'result',
      'payload',
      'index',
      'runner',
      'attempt',
      'source',
      'assignment',
      'symlink',
    ] as const) {
      const target = join(root, variant);
      await cp(f.packedRoot, target, { recursive: true });
      const publicEntry = f.descriptor.files.find((file) => file.path.includes('/public/'))!;
      if (variant === 'missing') await rm(join(target, publicEntry.path));
      if (variant === 'extra') await writeFile(join(target, 'extra.json'), '{}');
      if (['proof', 'result', 'payload'].includes(variant)) {
        const key = variant === 'payload' ? publicEntry.path : `partitions/0/${variant}.json`;
        const bytes = await readFile(join(target, key));
        bytes[0] = bytes[0]! ^ 1;
        await writeFile(join(target, key), bytes);
      }
      if (variant === 'index')
        await writeFile(join(target, 'index.json'), canonicalJson({ ...f.index, partitions: [] }));
      if (variant === 'symlink') {
        await rm(join(target, publicEntry.path));
        await symlink(join(f.packedRoot, publicEntry.path), join(target, publicEntry.path));
      }
      const identity = structuredClone(f.identity);
      if (variant === 'attempt') identity.runAttempt++;
      if (variant === 'source') identity.source.sha = 'd'.repeat(40);
      await expect(
        authenticatePackedGroup(
          target,
          f.artifact,
          identity,
          variant === 'runner' ? 1 : 0,
          variant === 'assignment' ? [1] : [0],
        ),
      ).rejects.toThrow();
    }
    const binding = await authenticatePackedGroup(f.packedRoot, f.artifact, f.identity, 0, [0]);
    await writeFile(join(f.packedRoot, 'partitions/0/result.json'), '{}');
    await expect(
      authenticatePackedLeagueProducer(
        join(f.packedRoot, 'partitions/0'),
        f.input,
        f.identity,
        0,
        binding,
      ),
    ).rejects.toThrow('changed');
    await expect(
      authenticatePackedGroup(f.packedRoot, f.artifact, f.identity, 0, [0]),
    ).rejects.toThrow();
    const changed = join(root, 'changed');
    await cp(f.producerRoot, changed, { recursive: true });
    await writeFile(join(changed, 'public', f.producer.proof.files[0]!.key), 'changed');
    await expect(packedProducerDescriptor(changed, f.producer.proof)).rejects.toThrow();
  });
});
it('finalizes two real partitions sharing one authenticated artifact exactly once', async () => {
  await withReplayDirectory(async (root) => {
    const f = await sealedTwoPartitionFixture(root),
      packedRoot = join(root, 'packed');
    const baseline = f.baseline,
      descriptors: PackedDescriptor[] = [];
    for (const producer of f.sealed) {
      await cp(producer.root, join(packedRoot, 'partitions', String(producer.proof.partition)), {
        recursive: true,
      });
      descriptors.push(await packedProducerDescriptor(producer.root, producer.proof));
    }
    expect(descriptors.map((p) => p.partition)).toEqual([0, 1]);
    await writeCloudJson(
      join(packedRoot, 'index.json'),
      packedIndex(f.identity, 0, 0, descriptors),
    );
    const artifact = {
      id: 456,
      name: 'league-123-1-runner-0-pack-0',
      digest: 'sha256:' + 'c'.repeat(64),
      bytes: 128,
    };
    const binding = await authenticatePackedGroup(packedRoot, artifact, f.identity, 0, [0, 1]);
    const producers: LeagueProducer[] = [];
    for (const index of [0, 1])
      producers.push(
        await authenticatePackedLeagueProducer(
          join(packedRoot, 'partitions', String(index)),
          await cloudInput(f.preparedRoot, f.prepared, index),
          f.identity,
          0,
          binding,
        ),
      );
    expect(uniqueProducerArtifacts(producers, f.identity)).toEqual([artifact]);
    expect(() => uniqueProducerArtifacts(producers.slice(0, 1), f.identity)).toThrow('Incomplete');
    expect(() => uniqueProducerArtifacts([producers[0]!, producers[0]!], f.identity)).toThrow();
    const legacy = producers.map((p) => {
      const value = { ...p };
      delete value.packed;
      return value;
    });
    expect(() => uniqueProducerArtifacts(legacy, f.identity)).toThrow('Duplicate');
    const terminal = {
      schemaVersion: 1,
      identity: f.identity,
      runner: 0,
      partitions: [0, 1],
      artifacts: [artifact],
    };
    await expect(
      finalizeLeaguePipeline(
        f.preparedRoot,
        join(root, 'missing'),
        producers,
        [{ ...terminal, artifacts: [] }],
        f.identity,
        1,
        async () => {},
        baseline,
      ),
    ).rejects.toThrow();
    const result = await finalizeLeaguePipeline(
      f.preparedRoot,
      join(root, 'final'),
      producers,
      [terminal],
      f.identity,
      1,
      async () => {},
      baseline,
    );
    expect(result).toMatchObject({ status: 'formal', planned: 144, resolved: 144 });
  });
}, 60000);
