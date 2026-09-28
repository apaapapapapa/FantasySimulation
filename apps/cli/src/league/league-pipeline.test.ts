import { expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { withReplayDirectory } from '@fantasy/api/testing';
import { Measurements } from '@fantasy/api/tooling';
import { pipelineFixture } from '../../test-support/league-pipeline.ts';
import { finishCloudLeague } from './league-cloud.ts';
import { finalizeLeaguePipeline } from './league-finalizer.ts';
import { authenticateLeagueProducer } from './league-producer.ts';
import { PublicationEvidence, evidenceGraph } from '../publication/publication-evidence.ts';

it('produces the same packed catalog with exact scoring and zero central recording decodes', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await pipelineFixture(root);
    const full = await finishCloudLeague(
      fixture.preparedRoot,
      fixture.resultRoot,
      fixture.fullRoot,
      fixture.identity.source,
      fixture.executionId,
      { packs: true, verificationWorkers: 1 },
    );
    const measured = new Measurements();
    let barrier = 0;
    const result = await measured.run(() =>
      finalizeLeaguePipeline(
        fixture.preparedRoot,
        join(root, 'final'),
        [fixture.producer],
        [fixture.terminal],
        fixture.identity,
        1,
        async () => {
          barrier++;
        },
        fixture.baseline,
      ),
    );
    expect(result.catalogHash).toBe(full.catalogHash);
    expect(result).toMatchObject({ status: 'formal', planned: 4, resolved: 4 });
    expect(barrier).toBe(1);
    expect(measured.report().validation.calls).toBe(0);
    expect(evidenceGraph(result.evidence).objects.size).toBe(4);
    const now = Date.now();
    const checkpoint = result.evidence.checkpoint(fixture.identity);
    const policy = {
      catalogHash: result.catalogHash,
      validatorDigest: fixture.identity.validatorDigest,
      now,
      maxAgeMs: 86400000,
      authenticate: async () => {},
    };
    const restored = await PublicationEvidence.restore(checkpoint, policy);
    expect(evidenceGraph(restored).current).toEqual(evidenceGraph(result.evidence).current);
    await expect(
      PublicationEvidence.restore(checkpoint, { ...policy, now: now + 86400001 }),
    ).rejects.toThrow('Stale');
    await expect(
      PublicationEvidence.restore({ ...checkpoint, replays: [] }, policy),
    ).rejects.toThrow();
    await expect(
      PublicationEvidence.restore(checkpoint, {
        ...policy,
        authenticate: async () => {
          throw new Error('foreign writer');
        },
      }),
    ).rejects.toThrow('foreign writer');
    expect(() => evidenceGraph({ verified: true } as unknown as PublicationEvidence)).toThrow(
      'capability',
    );
  });
}, 30000);

it('refuses foreign producers, incomplete terminals, failed jobs and changed pack bytes', async () => {
  await withReplayDirectory(async (root) => {
    const fixture = await pipelineFixture(root);
    await expect(
      authenticateLeagueProducer(
        fixture.producerRoot,
        fixture.input,
        { ...fixture.identity, runAttempt: 2 },
        0,
        async () => {},
      ),
    ).rejects.toThrow('identity');
    const finish = (terminals: unknown[], barrier = async () => {}) =>
      finalizeLeaguePipeline(
        fixture.preparedRoot,
        join(root, 'final'),
        [fixture.producer],
        terminals,
        fixture.identity,
        1,
        barrier,
        fixture.baseline,
      );
    await expect(finish([])).rejects.toThrow('terminal');
    await expect(
      finish([fixture.terminal], async () => {
        throw new Error('compute failure');
      }),
    ).rejects.toThrow('compute failure');
    const pack = fixture.producer.proof.files.find((file) => file.key.startsWith('packs/'))!;
    await writeFile(join(fixture.producerRoot, 'public', pack.key), Buffer.alloc(pack.bytes));
    await expect(
      authenticateLeagueProducer(
        fixture.producerRoot,
        fixture.input,
        fixture.identity,
        0,
        async () => {},
      ),
    ).rejects.toThrow('Pack checksum');
  });
}, 30000);
