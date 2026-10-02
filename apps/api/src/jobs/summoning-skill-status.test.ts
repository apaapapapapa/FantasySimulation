import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vite-plus/test';
import {
  ReplayManifestSchema,
  ReplayState,
  RevisionSchema,
  parseJson,
  replayChunkRecords,
  replayContext,
  revisionReference,
} from '@fantasy/domain/spatial';
import { catalogManifest } from '@fantasy/samples';
import { withRuntime } from '../../test-support/runtime.ts';
import { submitSkillJob } from '../../test-support/skill-job.ts';
import { readSampleRevisions } from '../db/store.ts';
import { seedStartupData } from '../db/startup-data.ts';
import { createApp } from '../http/app.ts';
import { REPLAY_VALIDATION_PROFILE } from '../replay/replay-reader.ts';
import fixture from '../../../../packages/engine/fixtures/spatial/summoning-rat-dan1-runtime-v1.json' with { type: 'json' };

it(
  'persists the saved production rat through schema-9 ReplayWriter SQLite and API replay',
  { timeout: 30_000 },
  async () => {
    await withRuntime(
      async ({ store, runtime, jobs }) => {
        const app = createApp(store, false, runtime),
          seeded = await seedStartupData(store),
          revisions = parseJson(RevisionSchema.array(), readSampleRevisions()),
          character = revisions.find(
            (revision) => revision.kind === 'character' && revision.id === 'swordsman',
          ),
          ability = revisions.find(
            (revision) => revision.kind === 'ability' && revision.id === fixture.ability.id,
          );
        if (character?.kind !== 'character' || ability?.kind !== 'ability')
          throw new Error('Missing production rat loadout revisions');
        expect(revisionReference(ability)).toEqual(fixture.ability);

        const saved = await app.inject({
          method: 'POST',
          url: '/api/skill-loadouts',
          payload: {
            character: revisionReference(character),
            configuration: {
              schemaVersion: 1,
              id: 'loadout.production.summoning.rat.1',
              version: 1,
              catalog: seeded.skillCatalog.reference,
              eligibilityNodeIds: [fixture.catalogNodeId],
              learnedNodeIds: [fixture.catalogNodeId],
              enabledNodeIds: [fixture.catalogNodeId],
            },
          },
        });
        expect(saved.statusCode).toBe(201);
        expect(saved.json().snapshot.resolved.nodeResolutions).toEqual([
          {
            nodeId: fixture.catalogNodeId,
            resolution: [{ kind: 'active-ability', ability: fixture.ability }],
          },
        ]);

        const input = await catalogManifest(
          'swordsman',
          'swordsman',
          'flat',
          6000,
          228,
          fixture.ruleset.id,
        );
        await store.seedRevisions(input.revisions);
        const jobId = await submitSkillJob(
            app,
            input,
            'summoning-skill',
            'production-rat-v1',
            saved.json().latest,
          ),
          done = await runtime.wait(jobId);
        if (done.state !== 'completed') throw new Error(JSON.stringify(done));
        const result = jobs.result(done.resultId!)!;
        expect(jobs.artifact(result.replayId)?.validationProfile).toBe(REPLAY_VALIDATION_PROFILE);

        const replayResponse = await app.inject(`/api/replays/${result.replayId}`);
        expect(replayResponse.statusCode).toBe(200);
        const manifest = ReplayManifestSchema.parse(replayResponse.json());
        expect(manifest.input.schemaVersion).toBe(fixture.expected.manifestSchemaVersion);
        expect(manifest.input.ruleset).toEqual(fixture.ruleset);
        expect(manifest.input.participants[0]?.skillLoadout).toMatchObject({
          loadout: saved.json().latest,
          resolvedNodeIds: [fixture.catalogNodeId],
          nodeResolutions: [
            {
              nodeId: fixture.catalogNodeId,
              resolution: [{ kind: 'active-ability', ability: fixture.ability }],
            },
          ],
        });

        const context = await replayContext(manifest.input, manifest.simulationHash),
          replay = new ReplayState(context),
          records = [];
        for (const ref of manifest.chunks) {
          const file = await app.inject(`/api/replays/${manifest.id}/files/${ref.file}`);
          expect(file.statusCode).toBe(200);
          for (const record of replayChunkRecords(
            gunzipSync(file.rawPayload).toString('utf8'),
            ref,
          )) {
            records.push(replay.apply(record));
          }
        }
        const events = records.flatMap((record) => ('events' in record ? record.events : []));
        expect(
          events.filter(
            (event) => event.kind === 'dependent-create' && event.abilityId === fixture.ability.id,
          ),
        ).toHaveLength(fixture.recipe.uses);
        expect(
          events.some(
            (event) => event.kind === 'dependent-command' && event.before?.mp === event.after?.mp,
          ),
        ).toBe(true);
        expect(events.some((event) => event.kind === 'dependent-act')).toBe(true);
        expect(events.some((event) => event.kind === 'dependent-despawn')).toBe(true);
        expect(replay.ended).toBe(true);
        expect(replay.checkpoint().state?.dependents ?? []).toHaveLength(0);
      },
      {},
      40,
    );
  },
);
