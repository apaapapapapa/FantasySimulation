import { expect, it, vi } from 'vite-plus/test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { withReplayDirectory } from '@fantasy/api/testing';
import { sha256 } from '@fantasy/api/artifacts';
import { pipelineFixture } from '../../test-support/league-pipeline.ts';
import { MemoryStore } from '../../test-support/remote-store.ts';
import { LeagueStaging } from './league-staging.ts';
import {
  checkpointArchiveKey,
  checkpointLocatorKey,
  persistLeagueCheckpoint,
  encodeLeagueCheckpoint,
  decodeLeagueCheckpoint,
} from './league-checkpoint.ts';
import { PublicationEvidence, evidenceGraph } from '../publication/publication-evidence.ts';

it('recovers an uncertain immutable PUT and preserves the pointer across replay and tamper rejection', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await pipelineFixture(root),
      store = new MemoryStore();
    const old = Buffer.from('previous generation');
    await store.put('catalog/current.json', old, null);
    const put = store.put.bind(store);
    let uncertain = true;
    vi.spyOn(store, 'put').mockImplementation(async (...args) => {
      await put(...args);
      if (uncertain) {
        uncertain = false;
        throw new Error('response lost after accepted PUT');
      }
    });
    const staging = new LeagueStaging(store, await store.inventory());
    await staging.stage(fixture.producer.evidence, join(fixture.producerRoot, 'public'));
    expect(staging.metrics().addedFiles).toBeGreaterThan(0);
    const count = store.writes.length;
    await staging.stage(fixture.producer.evidence, join(fixture.producerRoot, 'public'));
    expect(store.writes).toHaveLength(count);
    const pack = fixture.producer.proof.files.find((f) => f.key.startsWith('packs/'))!;
    await writeFile(join(fixture.producerRoot, 'public', pack.key), Buffer.alloc(pack.bytes));
    await expect(
      staging.stage(fixture.producer.evidence, join(fixture.producerRoot, 'public')),
    ).rejects.toThrow();
    await expect(
      staging.stage(fixture.producer.evidence, join(fixture.producerRoot, 'public')),
    ).rejects.toThrow('failed');
    expect(store.objects.get('catalog/current.json')!.data).toEqual(old);
    expect(store.writes.filter((key) => key === 'catalog/current.json')).toHaveLength(1);
    await staging.close();
  });
}, 30000);

it('rejects capacity before PUT and drains accepted writes when a parallel transfer fails', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await pipelineFixture(root),
      store = new MemoryStore();
    const limited = new LeagueStaging(store, await store.inventory(), 1);
    await expect(
      limited.stage(fixture.producer.evidence, join(fixture.producerRoot, 'public')),
    ).rejects.toThrow('capacity');
    expect(store.writes).toEqual([]);
    const put = store.put.bind(store);
    let active = 0,
      calls = 0;
    vi.spyOn(store, 'put').mockImplementation(async (...args) => {
      active++;
      const order = ++calls;
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (order === 1) throw new Error('transport unavailable');
        await put(...args);
      } finally {
        active--;
      }
    });
    const staging = new LeagueStaging(store, await store.inventory());
    await expect(
      staging.stage(fixture.producer.evidence, join(fixture.producerRoot, 'public')),
    ).rejects.toThrow('transport unavailable');
    expect(active).toBe(0);
    expect(store.objects.has('catalog/current.json')).toBe(false);
    await staging.close();
    await limited.close();
  });
}, 30000);

it('round-trips audited metadata and replaces a failed writer locator without deleting its immutable ZIP', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await pipelineFixture(root),
      store = new MemoryStore();
    const value = fixture.producer.evidence.checkpoint(fixture.identity),
      bytes = encodeLeagueCheckpoint(value);
    expect(decodeLeagueCheckpoint(bytes)).toEqual(value);
    const locator = {
      schemaVersion: 1,
      catalogHash: value.catalogHash,
      identity: fixture.identity,
      writerRun: fixture.identity.runId,
      writerAttempt: fixture.identity.runAttempt,
      artifactId: 1,
      archiveHash: sha256(bytes),
      archiveBytes: bytes.length,
    };
    await persistLeagueCheckpoint(store, locator, bytes);
    const next = Buffer.concat([bytes, Buffer.from('new authenticated writer archive')]);
    await persistLeagueCheckpoint(
      store,
      { ...locator, artifactId: 2, archiveHash: sha256(next), archiveBytes: next.length },
      next,
    );
    expect(store.objects.has(checkpointArchiveKey(locator.archiveHash))).toBe(true);
    expect(
      JSON.parse(store.objects.get(checkpointLocatorKey(value.catalogHash))!.data.toString())
        .artifactId,
    ).toBe(2);
    expect(store.removed).toEqual([]);
    expect(store.objects.has('catalog/current.json')).toBe(false);
    const broken = structuredClone(value);
    broken.replays[0]!.physical.pop();
    await expect(
      PublicationEvidence.restore(broken, {
        catalogHash: value.catalogHash,
        validatorDigest: fixture.identity.validatorDigest,
        now: Date.now(),
        maxAgeMs: 10000,
        authenticate: async () => {},
      }),
    ).rejects.toThrow('coverage');
    const reads: string[] = [];
    const original = evidenceGraph(fixture.producer.evidence);
    const audited = await PublicationEvidence.remoteAudit(async (key, limit) => {
      reads.push(key);
      const { readBoundedFile } = await import('@fantasy/api/artifacts');
      return readBoundedFile(join(fixture.producerRoot, 'public', key), limit);
    });
    expect(evidenceGraph(audited).current).toEqual(original.current);
    expect(reads.some((key) => key.startsWith('packs/'))).toBe(true);
  });
}, 30000);
