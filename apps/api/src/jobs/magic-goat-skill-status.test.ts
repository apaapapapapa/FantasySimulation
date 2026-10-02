import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vite-plus/test';
import {
  ReplayManifestSchema,
  ReplayState,
  replayChunkRecords,
  replayContext,
  revisionReference,
} from '@fantasy/domain/spatial';
import { runBattle } from '@fantasy/engine/spatial';
import { catalogManifest, sampleCatalog } from '@fantasy/samples';
import { initialStatus, withInitialStatus } from '../../../../packages/engine/test-support/ai.ts';
import { withRuntime } from '../../test-support/runtime.ts';
import { submitSkillJob } from '../../test-support/skill-job.ts';
import { seedStartupData } from '../db/startup-data.ts';
import { createApp } from '../http/app.ts';

const nodeId = 'skill.magic.goat.1';
const abilityId = 'self-water';

it(
  'persists goat self-water from saved v9 loadout through Worker SQLite and replay',
  { timeout: 30_000 },
  async () => {
    await withRuntime(
      async ({ store, runtime, jobs }) => {
        const app = createApp(store, false, runtime),
          seeded = await seedStartupData(store),
          revisions = await sampleCatalog(),
          character = revisions.find(
            (revision) => revision.kind === 'character' && revision.id === 'swordsman',
          ),
          ability = revisions.find(
            (revision) => revision.kind === 'ability' && revision.id === abilityId,
          );
        if (character?.kind !== 'character' || ability?.kind !== 'ability')
          throw new Error('Missing production goat revisions');
        expect(character.definition.abilities.map(({ id }) => id)).not.toContain(abilityId);
        expect(ability.definition.effects).toEqual([{ kind: 'water', extinguish: true }]);

        const saved = await app.inject({
          method: 'POST',
          url: '/api/skill-loadouts',
          payload: {
            character: revisionReference(character),
            configuration: {
              schemaVersion: 1,
              id: 'loadout.production.magic.goat.1',
              version: 1,
              catalog: seeded.skillCatalog.reference,
              eligibilityNodeIds: [nodeId],
              learnedNodeIds: [nodeId],
              enabledNodeIds: [nodeId],
            },
          },
        });
        expect(saved.statusCode).toBe(201);
        expect(saved.json().snapshot.resolved.nodeResolutions).toEqual([
          {
            nodeId,
            resolution: [{ kind: 'active-ability', ability: revisionReference(ability) }],
          },
        ]);

        const input = await catalogManifest('swordsman', 'swordsman', 'flat', 40, 42),
          burn = await withInitialStatus(
            input,
            0,
            initialStatus({
              stackKey: 'goat-water-extinguishable-burn',
              burning: { waterExtinguishable: true },
              periodic: [{ kind: 'damage', amount: 1, element: 'fire', everySteps: 10 }],
            }),
          ),
          withoutLoadout = await runBattle(structuredClone(input)),
          withoutEvents = withoutLoadout.records.flatMap((record) =>
            'events' in record ? record.events : [],
          );
        expect(
          withoutEvents.some((event) => event.kind === 'launch' && event.abilityId === abilityId),
        ).toBe(false);

        await store.seedRevisions(input.revisions);
        const activeSaved = await app.inject({
          method: 'POST',
          url: '/api/skill-loadouts',
          payload: {
            character: input.participants[0]!.character,
            configuration: {
              schemaVersion: 1,
              id: 'loadout.production.magic.goat.1.status-actor',
              version: 1,
              catalog: seeded.skillCatalog.reference,
              eligibilityNodeIds: [nodeId],
              learnedNodeIds: [nodeId],
              enabledNodeIds: [nodeId],
            },
          },
        });
        expect(activeSaved.statusCode).toBe(201);
        const jobId = await submitSkillJob(
            app,
            input,
            'magic-goat-skill',
            'magic-goat-v1',
            activeSaved.json().latest,
          ),
          done = await runtime.wait(jobId);
        if (done.state !== 'completed') throw new Error(JSON.stringify(done));
        const result = jobs.result(done.resultId!)!,
          response = await app.inject(`/api/replays/${result.replayId}`),
          manifest = ReplayManifestSchema.parse(response.json()),
          context = await replayContext(manifest.input, manifest.simulationHash),
          replay = new ReplayState(context),
          records = [];
        expect(manifest.input.participants[0]?.skillLoadout).toMatchObject({
          loadout: activeSaved.json().latest,
          resolvedNodeIds: [nodeId],
        });
        expect(context.actors[0]!.abilities.map(({ id }) => id)).toContain(abilityId);
        expect(
          context.actors[0]!.abilities.find(({ id }) => id === abilityId)?.definition,
        ).toMatchObject({ castSteps: 3, recoverySteps: 12, cooldownSteps: 25 });
        for (const ref of manifest.chunks) {
          const file = await app.inject(`/api/replays/${manifest.id}/files/${ref.file}`);
          for (const record of replayChunkRecords(
            gunzipSync(file.rawPayload).toString('utf8'),
            ref,
          ))
            records.push(replay.apply(record));
        }
        const events = records.flatMap((record) => ('events' in record ? record.events : [])),
          launch = events.find(
            (event) =>
              event.kind === 'launch' && event.actorId === 'left' && event.abilityId === abilityId,
          ),
          cost = events.find(
            (event) =>
              event.kind === 'cost' && event.actorId === 'left' && event.abilityId === abilityId,
          ),
          removal = events.find(
            (event) =>
              event.kind === 'status-remove' &&
              event.actorId === 'left' &&
              event.reason === `${burn.id}:dispel-existing`,
          ),
          decision = events.find(
            (event) =>
              event.kind === 'decision' &&
              event.actorId === 'left' &&
              event.cognition?.kind === 'decision' &&
              event.cognition.selection === `ability:${abilityId}`,
          );
        expect(launch).toBeDefined();
        expect(decision?.step).toBeLessThanOrEqual(launch!.step);
        expect(
          events.filter(
            (event) =>
              event.kind === 'launch' && event.actorId === 'left' && event.abilityId === abilityId,
          ),
        ).toHaveLength(1);
        if (!cost?.before || !cost.after) throw new Error('Missing production self-water cost');
        expect(cost.before.mp - cost.after.mp).toBe(ability.definition.costs.mp);
        expect(removal?.step).toBe(launch!.step + 1);
        expect(replay.ended).toBe(true);
      },
      {},
      40,
    );
  },
);
