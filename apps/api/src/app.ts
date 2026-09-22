import Fastify from 'fastify';
import { BattleRequestSchema, CharacterSchema } from '@fantasy/domain';
import { DEFAULT_RULESET, simulateBattle } from '@fantasy/engine';
import type { Store } from './store.ts';

export function createApp(store: Store, logger = false) {
  const app = Fastify({ logger, bodyLimit: 64 * 1024 });
  store.registerRuleset(DEFAULT_RULESET);
  app.addHook('onClose', async () => store.close());

  app.get('/api/health', async () => ({ status: 'ok', rulesVersion: DEFAULT_RULESET.version }));
  app.get('/api/rules', async () => DEFAULT_RULESET);
  app.get('/api/characters', async () => store.listCharacters());
  app.post('/api/characters', async (request, reply) => {
    const parsed = CharacterSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'キャラクターJSONが不正です。', issues: parsed.error.issues });
    }
    const exists = store.getCharacter(parsed.data.id) !== undefined;
    return reply.code(exists ? 200 : 201).send(store.saveCharacter(parsed.data));
  });
  app.get('/api/battles', async () => store.listBattles());
  app.post('/api/battles', async (request, reply) => {
    const parsed = BattleRequestSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.leftId === parsed.data.rightId) {
      return reply.code(400).send({ error: '異なる2人のキャラクターを選んでください。' });
    }
    const left = store.getCharacter(parsed.data.leftId);
    const right = store.getCharacter(parsed.data.rightId);
    if (!left || !right) return reply.code(404).send({ error: 'キャラクターが見つかりません。' });
    return reply.code(201).send(store.saveBattle([left, right], simulateBattle(left, right)));
  });
  return app;
}
