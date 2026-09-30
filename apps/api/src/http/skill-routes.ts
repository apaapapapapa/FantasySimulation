import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  IdSchema,
  SkillBattleJobRequestSchema,
  SkillLoadoutCreateSchema,
  SkillLoadoutPatchSchema,
  canonicalJson,
  skillBattleReceipt,
} from '@fantasy/domain';
import type { Store } from '../db/store.ts';
import { StoreError } from '../db/store-error.ts';
import { SkillStore } from '../db/skill-store.ts';
import type { BattleService } from '../jobs/battle-service.ts';
import { body } from './request-body.ts';

const idParams = z.strictObject({ id: IdSchema });
const catalogParams = z.strictObject({
  id: IdSchema,
  revision: z.coerce.number().int().min(1).max(1_000_000),
});
const clientKey = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/);
const pageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: IdSchema.optional(),
});

export function addSkillRoutes(app: FastifyInstance, store: Store, runtime?: BattleService) {
  const skills = new SkillStore(store);
  app.get('/api/skill-catalogs/:id/:revision', async (request) => {
    const { id, revision } = catalogParams.parse(request.params);
    return skills.catalog(id, revision);
  });
  app.post('/api/skill-loadouts', async (request, reply) =>
    reply.code(201).send(await skills.create(body(SkillLoadoutCreateSchema, request.body))),
  );
  app.get('/api/skill-loadouts', async (request) => {
    const query = pageQuery.parse(request.query);
    return skills.list(query.limit, query.cursor);
  });
  app.get('/api/skill-loadouts/:id', async (request) =>
    skills.head(idParams.parse(request.params).id),
  );
  app.patch('/api/skill-loadouts/:id', async (request) => {
    const { id } = idParams.parse(request.params);
    return skills.patch(id, body(SkillLoadoutPatchSchema, request.body));
  });
  if (!runtime) return;
  app.post('/api/skill-battle-jobs', async (request, reply) => {
    const input = body(SkillBattleJobRequestSchema, request.body);
    if (input.spec.participants.some((participant) => participant.skillLoadout))
      throw new StoreError('invalid-input', 'Base skill battle spec must not contain a receipt');
    const participants = structuredClone(input.spec.participants);
    for (const selected of input.loadouts) {
      const index = participants.findIndex(
        (participant) => participant.actorId === selected.actorId,
      );
      if (index < 0)
        throw new StoreError('invalid-input', 'Skill loadout actor is not a participant');
      const snapshot = await skills.revision(selected.loadout);
      if (canonicalJson(snapshot.character) !== canonicalJson(participants[index]!.character))
        throw new StoreError('invalid-input', 'Skill loadout character does not match participant');
      try {
        participants[index]!.skillLoadout = await skillBattleReceipt(snapshot);
      } catch (error) {
        throw new StoreError(
          'invalid-input',
          (error instanceof Error ? error.message : 'Invalid skill battle receipt').slice(0, 1000),
        );
      }
    }
    const client = clientKey.parse(request.headers['x-client-id']),
      key = clientKey.parse(request.headers['idempotency-key']),
      spec = { ...input.spec, participants },
      job = await runtime.submit(spec, `POST/skill-battle-jobs:${client}`, key, input.budget);
    return reply.code(job.state === 'completed' ? 200 : 202).send({ job });
  });
  return skills;
}
