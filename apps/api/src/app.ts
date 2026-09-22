import Fastify from 'fastify';
import { z } from 'zod';
import {
  DefinitionKindSchema,
  DraftInputSchema,
  DraftPatchSchema,
  ExpectedVersionSchema,
  IdSchema,
  parseJson,
} from '@fantasy/domain/spatial';
import { StoreError, type Store } from './store.ts';

const idParams = z.strictObject({ id: IdSchema });
const pageQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: IdSchema.optional(),
});
const revisionQuery = z.strictObject({
  revision: z.coerce.number().int().min(1).max(2147483647).optional(),
});
function body<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  try {
    return parseJson(schema, input);
  } catch (error) {
    throw new StoreError(
      400,
      (error instanceof Error ? error.message : 'Invalid JSON').slice(0, 1000),
    );
  }
}
export function createApp(store: Store, logger = false) {
  const app = Fastify({ logger, bodyLimit: 512 * 1024 });
  app.addHook('onClose', async () => store.close());
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof StoreError)
      return reply.code(error.statusCode).send({ error: error.message });
    if (error instanceof z.ZodError)
      return reply.code(400).send({ error: error.message.slice(0, 1000) });
    if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    )
      return reply.code(error.statusCode).send({ error: error.message });
    request.log.error(error);
    return reply.code(500).send({ error: 'Internal server error' });
  });
  app.get('/api/health', async () => ({
    status: 'ok',
    engineVersion: 'spatial-v1.10',
    migrationTool: 'drizzle',
  }));
  for (const [path, kind] of [
    ['characters', 'character'],
    ['rulesets', 'ruleset'],
    ['scenarios', 'scenario'],
  ] as const) {
    app.get('/api/' + path, async (request) => {
      const q = pageQuery.parse(request.query);
      return store.listRevisions(kind, q.limit, q.cursor);
    });
  }
  app.get('/api/characters/:id', async (request) => {
    const { id } = idParams.parse(request.params),
      q = revisionQuery.parse(request.query),
      revision = store.getRevision('character', id, q.revision);
    if (!revision) throw new StoreError(404, 'Character revision not found');
    return revision;
  });
  app.get('/api/revisions/:kind', async (request) => {
    const { kind } = z.strictObject({ kind: DefinitionKindSchema }).parse(request.params),
      q = pageQuery.parse(request.query);
    return store.listRevisions(kind, q.limit, q.cursor);
  });
  app.get('/api/revisions/:kind/:id/:revision', async (request) => {
    const p = z
      .strictObject({
        kind: DefinitionKindSchema,
        id: IdSchema,
        revision: z.coerce.number().int().min(1).max(2147483647),
      })
      .parse(request.params);
    const r = store.getRevision(p.kind, p.id, p.revision);
    if (!r) throw new StoreError(404, 'Revision not found');
    return r;
  });
  app.post('/api/drafts', async (request, reply) =>
    reply.code(201).send(store.createDraft(body(DraftInputSchema, request.body))),
  );
  app.get('/api/drafts/:id', async (request) => {
    const draft = store.getDraft(idParams.parse(request.params).id);
    if (!draft) throw new StoreError(404, 'Draft not found');
    return draft;
  });
  app.patch('/api/drafts/:id', async (request) => {
    const { id } = idParams.parse(request.params),
      input = body(DraftPatchSchema, request.body);
    return store.patchDraft(id, input.expectedVersion, input.definition);
  });
  app.post('/api/drafts/:id/validate', async (request) =>
    store.validateDraft(idParams.parse(request.params).id),
  );
  app.post('/api/drafts/:id/publish', async (request, reply) => {
    const { id } = idParams.parse(request.params),
      input = body(ExpectedVersionSchema, request.body);
    return reply.code(201).send(await store.publishDraft(id, input.expectedVersion));
  });
  return app;
}
