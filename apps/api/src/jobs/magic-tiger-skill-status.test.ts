import { expect, it } from 'vite-plus/test';
import {
  ReplayManifestSchema,
  RevisionSchema,
  parseJson,
  revisionReference,
} from '@fantasy/domain/spatial';
import { catalogManifest } from '@fantasy/samples';
import { readSkillReplay, submitSkillJob } from '../../test-support/skill-job.ts';
import { saveSkillLoadoutV2 } from '../../test-support/skills.ts';
import { withRuntime } from '../../test-support/runtime.ts';
import { readSampleRevisions } from '../db/store.ts';
import { seedStartupData } from '../db/startup-data.ts';
import { createApp } from '../http/app.ts';
import { REPLAY_VALIDATION_PROFILE } from '../replay/replay-reader.ts';

const ratNode = 'skill.magic.rat.1';
const tigerOne = 'skill.magic.tiger.1';
const tigerTwo = 'skill.magic.tiger.2';
const flareId = 'ordinary-flare';

it(
  'persists shared rat and tiger grants once through worker SQLite artifact and API replay',
  { timeout: 30_000 },
  async () => {
    await withRuntime(
      async ({ store, runtime, jobs }) => {
        const app = createApp(store, false, runtime),
          seeded = await seedStartupData(store),
          revisions = parseJson(RevisionSchema.array(), readSampleRevisions()),
          character = revisions.find(
            (revision) => revision.kind === 'character' && revision.id === 'ember-duelist',
          ),
          flare = revisions.find(
            (revision) => revision.kind === 'ability' && revision.id === flareId,
          );
        if (character?.kind !== 'character' || flare?.kind !== 'ability')
          throw new Error('Missing production tiger revisions');
        expect(revisionReference(flare)).toEqual({
          id: flareId,
          revision: 1,
          contentHash: 'sha256:ebe6c0f4194d04a18d9d657a3fdd2b692a86b1ccb82b291d6b5885e17ddc5c42',
        });

        const saved = await saveSkillLoadoutV2(app, {
          id: 'loadout.production.magic.tiger.2.shared',
          acquisitionId: 'acquisition.production.magic.tiger.2.shared',
          character: revisionReference(character),
          catalog: seeded.skillCatalog.reference,
          learnedNodeIds: [ratNode, tigerOne, tigerTwo],
          enabledNodeIds: [ratNode, tigerTwo],
        });
        if (saved.statusCode !== 201) throw new Error(`${saved.statusCode}: ${saved.body}`);
        const receipt = saved.json().snapshot.resolved;
        expect(receipt.nodeResolutions).toHaveLength(3);
        expect(
          receipt.nodeResolutions
            .filter(({ nodeId }: { nodeId: string }) => [ratNode, tigerTwo].includes(nodeId))
            .map(({ resolution }: { resolution: { ability: { id: string } }[] }) =>
              resolution.map(({ ability }) => ability.id),
            ),
        ).toEqual([[flareId], [flareId]]);

        const input = await catalogManifest('ember-duelist', 'swordsman', 'flat', 200, 228);
        await store.seedRevisions(input.revisions);
        const jobId = await submitSkillJob(
            app,
            input,
            'magic-tiger-skill',
            'tiger-rat-v3',
            saved.json().latest,
          ),
          done = await runtime.wait(jobId);
        if (done.state !== 'completed') throw new Error(JSON.stringify(done));
        expect(done.resultId).toBeTruthy();
        const result = jobs.result(done.resultId!)!;
        expect(jobs.artifact(result.replayId)?.validationProfile).toBe(REPLAY_VALIDATION_PROFILE);

        const response = await app.inject(`/api/replays/${result.replayId}`),
          manifest = ReplayManifestSchema.parse(response.json());
        expect(response.statusCode).toBe(200);
        expect(manifest.input.participants[0]?.skillLoadout).toMatchObject({
          schemaVersion: 3,
          resolvedNodeIds: [tigerOne, tigerTwo, ratNode].sort(),
        });
        const { context, replay, records } = await readSkillReplay(app, manifest);
        expect(context.actors[0]!.abilities.filter(({ id }) => id === flareId)).toHaveLength(1);
        const events = records.flatMap((record) => ('events' in record ? record.events : []));
        expect(events.some((event) => event.kind === 'launch' && event.abilityId === flareId)).toBe(
          true,
        );
        expect(replay.ended).toBe(true);
      },
      {},
      200,
    );
  },
);
