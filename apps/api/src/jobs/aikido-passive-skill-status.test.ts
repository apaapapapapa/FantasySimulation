import { expect, it } from 'vite-plus/test';
import {
  ReplayManifestSchema,
  RevisionSchema,
  parseJson,
  revisionReference,
} from '@fantasy/domain/spatial';
import { catalogManifest } from '@fantasy/samples';
import { readSkillReplay, submitSkillJob } from '../../test-support/skill-job.ts';
import { withRuntime } from '../../test-support/runtime.ts';
import { readSampleRevisions } from '../db/store.ts';
import { seedStartupData } from '../db/startup-data.ts';
import { createApp } from '../http/app.ts';
import { REPLAY_VALIDATION_PROFILE } from '../replay/replay-reader.ts';

const nodeId = 'skill.aikido.dog.1';
const abilityId = 'parry-v1';

it(
  'persists the Aikido passive through Worker SQLite artifact and replay',
  { timeout: 30_000 },
  async () => {
    await withRuntime(
      async ({ store, runtime, jobs }) => {
        const app = createApp(store, false, runtime),
          seeded = await seedStartupData(store),
          revisions = parseJson(RevisionSchema.array(), readSampleRevisions()),
          parry = revisions.find(
            (revision) => revision.kind === 'ability' && revision.id === abilityId,
          ),
          input = await catalogManifest(
            'posture-duelist-v1',
            'phoenix-duelist-v1',
            'flat',
            200,
            228,
          );
        if (parry?.kind !== 'ability') throw new Error('Missing production Aikido passive');
        expect(parry.definition).toMatchObject({
          trigger: 'before-hit',
          costs: { stamina: 4, uses: 0 },
          reaction: { response: { kind: 'parry', scope: 'all' } },
        });

        await store.seedRevisions(input.revisions);
        const saved = await app.inject({
          method: 'POST',
          url: '/api/skill-loadouts',
          payload: {
            character: input.participants[0]!.character,
            configuration: {
              schemaVersion: 1,
              id: 'loadout.production.aikido.dog.1.passive',
              version: 1,
              catalog: seeded.skillCatalog.reference,
              eligibilityNodeIds: [nodeId],
              learnedNodeIds: [nodeId],
              enabledNodeIds: [nodeId],
            },
          },
        });
        if (saved.statusCode !== 201) throw new Error(`${saved.statusCode}: ${saved.body}`);
        expect(saved.json().snapshot.resolved.nodeResolutions).toEqual([
          {
            nodeId,
            resolution: [{ kind: 'passive-ability', ability: revisionReference(parry) }],
          },
        ]);

        const done = await runtime.wait(
          await submitSkillJob(
            app,
            input,
            'aikido-passive-skill',
            'aikido-dog-v2',
            saved.json().latest,
          ),
        );
        expect(done.state).toBe('completed');
        if (!done.resultId) throw new Error(`Missing result: ${JSON.stringify(done)}`);
        const result = jobs.result(done.resultId);
        if (!result) throw new Error(`Missing persisted result: ${done.resultId}`);
        expect(jobs.artifact(result.replayId)?.validationProfile).toBe(REPLAY_VALIDATION_PROFILE);

        const response = await app.inject(`/api/replays/${result.replayId}`),
          manifest = ReplayManifestSchema.parse(response.json());
        expect(response.statusCode).toBe(200);
        expect(manifest.input.participants[0]?.skillLoadout).toMatchObject({
          schemaVersion: 2,
          loadout: saved.json().latest,
          resolvedNodeIds: [nodeId],
          nodeResolutions: [
            {
              nodeId,
              resolution: [{ kind: 'passive-ability', ability: revisionReference(parry) }],
            },
          ],
        });

        const { context, replay, records } = await readSkillReplay(app, manifest);
        expect(context.actors[0]!.abilities).toEqual(
          expect.arrayContaining([expect.objectContaining(revisionReference(parry))]),
        );
        const events = records.flatMap((record) => ('events' in record ? record.events : [])),
          activations = events.filter(
            (event) =>
              event.kind === 'reaction' &&
              event.actorId === 'left' &&
              event.abilityId === abilityId &&
              event.ruleId === 'reaction.activated',
          );
        expect(activations.length).toBeGreaterThan(0);
        for (const activation of activations) {
          const cost = events.find((event) => event.id === activation.parentEventId);
          expect(cost).toMatchObject({
            kind: 'cost',
            actorId: 'left',
            ruleId: 'reaction.cost-group',
          });
          if (!cost?.before || !cost.after) throw new Error('Missing Aikido reaction cost');
          expect(cost.before.stamina! - cost.after.stamina!).toBe(parry.definition.costs.stamina);
        }
        expect(replay.ended).toBe(true);
      },
      {},
      200,
    );
  },
);
