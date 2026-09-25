import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  IdSchema,
  BudgetSchema,
  JobRequestSchema,
  RetryJobSchema,
  parseJson,
} from '@fantasy/domain/spatial';
import type { BattleService } from './battle-service.ts';

const idParams = z.strictObject({ id: IdSchema });
const clientKey = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/);
export function addJobRoutes(app: FastifyInstance, runtime: BattleService) {
  app.post('/api/battle-jobs', async (request, reply) => {
    const { spec, budget } = parseJson(JobRequestSchema, request.body);
    const client = clientKey.parse(request.headers['x-client-id']),
      key = clientKey.parse(request.headers['idempotency-key']);
    const job = await runtime.submit(spec, `POST/battle-jobs:${client}`, key, budget);
    return reply.code(job.state === 'completed' ? 200 : 202).send({ job });
  });
  app.get('/api/battle-jobs/:id', async (request) =>
    runtime.status(idParams.parse(request.params).id),
  );
  app.post('/api/battle-jobs/:id/cancel', async (request) => ({
    job: runtime.cancel(idParams.parse(request.params).id),
  }));
  app.post('/api/battle-jobs/:id/retry', async (request, reply) => {
    const { id } = idParams.parse(request.params),
      input = parseJson(RetryJobSchema, request.body);
    return reply
      .code(202)
      .send({ job: await runtime.retry(id, input.expectedAttempts, input.budget) });
  });
  app.get('/api/battle-results/:id', async (request) =>
    runtime.result(idParams.parse(request.params).id),
  );
  app.post('/api/battle-results/:id/replay-recovery', async (request, reply) => {
    const { id } = idParams.parse(request.params),
      { budget } = parseJson(z.strictObject({ budget: BudgetSchema }), request.body);
    const client = clientKey.parse(request.headers['x-client-id']),
      key = clientKey.parse(request.headers['idempotency-key']);
    return reply.code(202).send({
      job: await runtime.recoverReplay(id, `POST/replay-recovery:${client}`, key, budget),
    });
  });
  app.get('/api/replays/:id', async (request) => runtime.replay(idParams.parse(request.params).id));
  app.get('/api/replays/:id/files/:file', async (request, reply) => {
    const { id, file } = z
      .strictObject({ id: IdSchema, file: z.string().max(96) })
      .parse(request.params);
    const bytes = await runtime.replayFile(id, file);
    return reply.type('application/gzip').header('Cache-Control', 'no-store').send(bytes);
  });
}
