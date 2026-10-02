import { DEFAULT_BUDGET, type Manifest, type RevisionRef } from '@fantasy/domain/spatial';
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
