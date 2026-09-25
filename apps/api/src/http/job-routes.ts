import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  IdSchema,
  BudgetSchema,
  JobRequestSchema,
  JobViewSchema,
  StagedJobRequestSchema,
  RetryJobSchema,
  parseJson,
} from '@fantasy/domain/spatial';
import type { BattleService } from '../jobs/battle-service.ts';

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
  app.post('/api/battle-jobs/staged', async (request, reply) => {
    const { jobs } = parseJson(StagedJobRequestSchema, request.body);
    const client = clientKey.parse(request.headers['x-client-id']);
    const abort = new AbortController();
    const stream = Readable.from(
      (async function* () {
        for await (const outcome of runtime.runMany(jobs, `POST/battle-jobs:${client}`, {
          signal: abort.signal,
        })) {
          // Streaming errors are per-key outcomes; never expose raw persistence diagnostics.
          yield (
            JSON.stringify({
              key: outcome.key,
              job: outcome.job ? JobViewSchema.parse(outcome.job) : null,
              error: outcome.job ? null : 'Job could not be admitted or completed',
            }) + '\n'
          );
        }
      })(),
    );
    reply.raw.once('close', () => abort.abort(new Error('HTTP consumer closed')));
    return reply.type('application/x-ndjson').header('Cache-Control', 'no-store').send(stream);
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
