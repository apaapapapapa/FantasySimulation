import { gunzipSync } from 'node:zlib';
import {
  DEFAULT_BUDGET,
  ReplayManifestSchema,
  ReplayState,
  replayChunkRecords,
  replayContext,
  type Manifest,
  type RevisionRef,
} from '@fantasy/domain/spatial';
import type { createApp } from '../src/http/app.ts';
import { specInput } from './runtime.ts';

/** Submit one saved skill loadout through the public job route and return its persisted job id. */
export async function submitSkillJob(
  app: ReturnType<typeof createApp>,
  input: Manifest,
  clientId: string,
  key: string,
  loadout: RevisionRef,
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/skill-battle-jobs',
    headers: { 'x-client-id': clientId, 'idempotency-key': key },
    payload: {
      spec: specInput(input),
      budget: DEFAULT_BUDGET,
      loadouts: [{ actorId: 'left', loadout }],
    },
  });
  if (response.statusCode !== 202) throw new Error(`${response.statusCode}: ${response.body}`);
  return response.json().job.id as string;
}

/** Read and apply every persisted replay chunk through the public file route. */
export async function readSkillReplay(
  app: ReturnType<typeof createApp>,
  manifest: ReturnType<typeof ReplayManifestSchema.parse>,
) {
  const context = await replayContext(manifest.input, manifest.simulationHash),
    replay = new ReplayState(context),
    records: ReturnType<ReplayState['apply']>[] = [];
  for (const ref of manifest.chunks) {
    const file = await app.inject(`/api/replays/${manifest.id}/files/${ref.file}`);
    for (const record of replayChunkRecords(gunzipSync(file.rawPayload).toString('utf8'), ref))
      records.push(replay.apply(record));
  }
  return { context, replay, records };
}
