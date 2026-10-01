import { afterEach, expect, it, vi } from 'vite-plus/test';
import artifact from '@actions/artifact';
import { cp, readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { withReplayDirectory } from '@fantasy/api/testing';
import { sealedTwoPartitionFixture } from '../apps/cli/test-support/league-pipeline.ts';
import { cloudInput, cloudJson } from '../apps/cli/src/league/league-cloud-files.ts';
import { finalizeLeaguePipeline } from '../apps/cli/src/league/league-finalizer.ts';
import {
  authenticateLeagueProducer,
  authenticatePackedLeagueProducer,
  type LeagueProducer,
} from '../apps/cli/src/league/league-producer.ts';
import {
  authenticatePackedGroup,
  packedPath,
  type PackedIndex,
} from '../apps/cli/src/league/league-producer-transport.ts';
import { evidenceGraph } from '../apps/cli/src/publication/publication-evidence.ts';
import { publicationInventory } from '../apps/cli/src/publication/publication-files.ts';
import { PackedLeagueUpload } from './league-packed-upload.ts';
import { uploadPipelineArtifact } from './league-pipeline-upload.ts';
import type { PipelineArtifact } from './league-pipeline-artifacts.ts';
import { archiveHash, extractLeagueArchive } from './league-archive.ts';
import { realArtifactZip } from './test-support/league-zip.ts';

afterEach(() => vi.restoreAllMocks());

it('roundtrips two real sealed partitions through the writer and SDK ZIP into one fully authenticated shared ref', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await sealedTwoPartitionFixture(root);
    const captured = new Map<string, Buffer>();
    // Only the external service is synthetic. ZIP bytes/digests/size are the actual SDK result;
    // these local numeric IDs do not constitute GitHub service authentication evidence.
    vi.spyOn(artifact, 'uploadArtifact').mockImplementation(async (name, files, sourceRoot) => {
      const zip = await realArtifactZip(files, sourceRoot);
      expect(zip.length).toBeLessThanOrEqual(64 * 1024 ** 2);
      expect(
        [...captured.values()].reduce((n, bytes) => n + bytes.length, zip.length),
      ).toBeLessThanOrEqual(64 * 1024 ** 2);
      captured.set(name, zip);
      return { id: 700 + captured.size, size: zip.length, digest: archiveHash(zip).slice(7) };
    });
    const legacyRoots = [];
    for (const producer of fixture.sealed) {
      const destination = join(root, 'legacy', String(producer.proof.partition));
      await cp(producer.root, destination, { recursive: true });
      legacyRoots.push(destination);
    }
    const references: PipelineArtifact[] = [];
    const writer = new PackedLeagueUpload(
      join(root, 'packed-spool'),
      fixture.identity,
      0,
      new AbortController().signal,
      references,
    );
    try {
      // Both producers already exist: the unchanged five-second timer no longer includes
      // computing/sealing the next partition. No fake clock or increased bounds are used.
      for (const producer of fixture.sealed)
        expect(await writer.append(producer.root, producer.proof)).toBe(true);
      await writer.finish();
    } finally {
      await writer.close();
    }
    expect(references).toHaveLength(1);
    expect(artifact.uploadArtifact).toHaveBeenCalledTimes(1);
    const reference = references[0]!,
      packedZip = captured.get(reference.name)!;
    expect(reference.digest).toBe(archiveHash(packedZip));
    expect(reference.bytes).toBe(packedZip.length);
    const packedRoot = join(root, 'received-packed');
    await extractLeagueArchive(packedZip, packedRoot, packedPath, false);
    const index = (await cloudJson(join(packedRoot, 'index.json'))) as PackedIndex;
    expect(index.partitions.map((partition) => partition.partition)).toEqual([0, 1]);
    expect((await readFile(join(packedRoot, 'index.json'))).length).toBeLessThanOrEqual(65536);
    const packedFiles = [
      'index.json',
      ...index.partitions.flatMap((partition) => partition.files.map((file) => file.path)),
    ];
    const packedSizes = await Promise.all(packedFiles.map((file) => lstat(join(packedRoot, file))));
    expect(packedSizes.reduce((n, info) => n + info.size, 0)).toBeLessThanOrEqual(48 * 1024 ** 2);
    const binding = await authenticatePackedGroup(
      packedRoot,
      reference,
      fixture.identity,
      0,
      [0, 1],
    );
    const packed: LeagueProducer[] = [],
      legacy: LeagueProducer[] = [];
    for (const partition of [0, 1]) {
      const input = await cloudInput(fixture.preparedRoot, fixture.prepared, partition);
      packed.push(
        await authenticatePackedLeagueProducer(
          join(packedRoot, 'partitions', String(partition)),
          input,
          fixture.identity,
          0,
          binding,
        ),
      );
      const producerRoot = legacyRoots[partition]!;
      const files = [
        join(producerRoot, 'proof.json'),
        join(producerRoot, 'result.json'),
        ...[...(await publicationInventory(join(producerRoot, 'public'))).keys()].map((key) =>
          join(producerRoot, 'public', key),
        ),
      ];
      const ref = await uploadPipelineArtifact(
        `league-123-1-runner-0-partition-${partition}-part-0-of-1`,
        files,
        producerRoot,
      );
      const zip = captured.get(ref.name)!;
      expect(ref.digest).toBe(archiveHash(zip));
      const destination = join(root, 'received-legacy-' + partition);
      await extractLeagueArchive(
        zip,
        destination,
        (key) => key === 'proof.json' || key === 'result.json' || key.startsWith('public/'),
        false,
      );
      legacy.push(
        await authenticateLeagueProducer(destination, input, fixture.identity, 0, async () => [
          ref,
        ]),
      );
    }
    const finalize = (producers: LeagueProducer[], directory: string, refs: PipelineArtifact[]) =>
      finalizeLeaguePipeline(
        fixture.preparedRoot,
        join(root, directory),
        producers,
        [
          {
            schemaVersion: 1,
            identity: fixture.identity,
            runner: 0,
            partitions: [0, 1],
            artifacts: refs,
          },
        ],
        fixture.identity,
        1,
        async () => {},
        fixture.baseline,
      );
    const packedResult = await finalize(packed, 'final-packed', references);
    const legacyResult = await finalize(
      legacy,
      'final-legacy',
      legacy.flatMap((producer) => producer.artifacts),
    );
    expect(packedResult).toMatchObject({ status: 'formal', planned: 144, resolved: 144 });
    const { evidence: packedEvidence, ...packedSummary } = packedResult;
    const { evidence: legacyEvidence, ...legacySummary } = legacyResult;
    expect(packedSummary).toEqual(legacySummary);
    const packedGraph = evidenceGraph(packedEvidence),
      legacyGraph = evidenceGraph(legacyEvidence);
    expect(packedGraph.current).toEqual(legacyGraph.current);
    expect(packedGraph.catalog).toEqual(legacyGraph.catalog);
    expect(packedGraph.latestWork).toEqual(legacyGraph.latestWork);
    expect(packedGraph.replays.size).toBe(144);
    const identities = (graph: typeof packedGraph) =>
      [...graph.replays].map(([hash, replay]) => ({
        hash,
        ref: replay.ref,
        receipt: replay.receipt,
        manifest: replay.manifest,
      }));
    expect(identities(packedGraph)).toEqual(identities(legacyGraph));
  });
}, 60000);
