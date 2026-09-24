import { beforeAll, expect, it } from 'vite-plus/test';
import { aiFixture, withEvaluation } from '../../test-support/ai.ts';
import { tacticalManifest } from '../../test-support/tactics.ts';
import { initializePhysics } from './physics.ts';
import { surveySearch, chooseSearch } from './search.ts';
import { TACTICAL_AI } from '@fantasy/samples';
import { runBattle } from './run.ts';
import { battleEvents } from '../../test-support/fixtures.ts';
import { choosePolicy } from './policy.ts';
import { initialDecisionRandom } from './decision-random.ts';

beforeAll(initializePhysics);
it('requires low delayed sight, revisits old cells and overrides hold at the common waiting limit', async () => {
  const f = await aiFixture();
  try {
    const bounds = { min: { x: -10000, y: 0, z: -10000 }, max: { x: 10000, y: 10000, z: 10000 } };
    const rule = TACTICAL_AI.search!;
    let search = surveySearch(f.self, bounds, rule, 0, undefined, null, (p) => p.y > 0.2);
    expect(search.pending[0]!.cells).toEqual([]);
    search = surveySearch(f.self, bounds, rule, 5, search, null, () => true);
    expect(search.cells.every((c) => c.confirmedAt === null)).toBe(true);
    search = surveySearch(f.self, bounds, rule, 10, search, null, () => false);
    expect(search.cells.every((c) => c.confirmedAt === 5)).toBe(true);
    const view = {
      ...f.view,
      rules: TACTICAL_AI,
      memory: { ...f.view.memory, observation: null, lastSeen: null, search },
      step: 100,
    };
    const low = withEvaluation(view, { searchAggressionBps: 0 });
    expect(chooseSearch(low, undefined)).toBeNull();
    const forced = choosePolicy({ ...low, step: 500 }, new Set(), false, initialDecisionRandom(42));
    expect(forced.goal).not.toBeNull();
    expect(forced.cognition?.search?.forced).toBe(true);
    expect(forced.random?.action).toBe(initialDecisionRandom(42).action);
    expect(
      chooseSearch({ ...view, step: 505 }, undefined)!.candidates.some((c) => c.weight > 0),
    ).toBe(true);
    const eager = withEvaluation(low, { searchAggressionBps: 10000 });
    expect(chooseSearch(eager, undefined)?.goal).not.toBeNull();
  } finally {
    f.world.free();
  }
});
it('investigates the last observation before cells and treats incoming cues only as directions', async () => {
  const f = await aiFixture();
  try {
    const search = {
      cells: [{ position: { x: 5, y: 0.1, z: 5 }, confirmedAt: null }],
      pending: [],
      cues: [
        {
          id: 'hit',
          sampledAt: 10,
          availableAt: 15,
          origin: { x: 0, y: 1, z: 0 },
          direction: { x: 0, y: 0, z: 1 },
        },
      ],
      lastContactAt: 0,
      investigatedAt: -1,
    };
    const view = {
      ...f.view,
      rules: TACTICAL_AI,
      step: 15,
      memory: { ...f.view.memory, observation: null, lastSeen: null, search },
    };
    expect(chooseSearch(view, 42)?.goal).toEqual({ x: 0, y: f.self.position.y, z: 3 });
    const lastSeen = { ...f.view.memory.observation!.enemy!, step: 14 };
    expect(
      chooseSearch({ ...view, memory: { ...view.memory, lastSeen } }, 42)?.memory.goal?.key,
    ).toBe('last-seen');
  } finally {
    f.world.free();
  }
});
it.each(['pillars-surveyed-v1', 'search-observed-v1'])(
  'finds initially hidden ground opponents in %s and repeats the result',
  async (scenario) => {
    const manifest = await tacticalManifest(scenario, 6000);
    const first = await runBattle(manifest),
      second = await runBattle(manifest);
    expect(first.result).toEqual(second.result);
    expect(['win', 'draw']).toContain(first.result.outcome.kind);
    expect(
      battleEvents(first.records).filter((e) => e.kind === 'cast-start').length,
    ).toBeGreaterThan(0);
    expect(
      battleEvents(first.records).some(
        (e) => e.cognition?.kind === 'decision' && e.cognition.search,
      ),
    ).toBe(true);
    expect(
      battleEvents(first.records).some(
        (e) =>
          e.cognition?.kind === 'decision' &&
          e.cognition.search?.checkedAt.some((at) => at !== null),
      ),
    ).toBe(true);
  },
  30000,
);
