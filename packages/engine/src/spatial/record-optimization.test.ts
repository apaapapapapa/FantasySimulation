import { beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import {
  canonicalJson,
  deepFreeze,
  DEFAULT_BUDGET,
  type StreamRecord,
} from '@fantasy/domain/spatial/execution';
import { terrainBattle } from '../../test-support/fixtures.ts';
import { initialActor, displayActor } from './sim/combat-state.ts';
import { revivalAbilityIds } from './sim/display-plan.ts';
import { StepTransaction } from './sim/step-transaction.ts';
import { WorkMeter } from './sim/work-meter.ts';
import { HitLedger } from './rules/hit-ledger.ts';
import { displayChanges, Journal, recordBytes } from './rules/journal.ts';
import { initializePhysics } from './world/physics.ts';
import { createBattleWorld } from './world/terrain.ts';

beforeAll(initializePhysics);
describe('record optimization preserves public and transaction boundaries', () => {
  it('keeps display deltas exact and computes each phase object delta once', async () => {
    const battle = await terrainBattle(),
      world = createBattleWorld(battle);
    try {
      const actor = initialActor(world, battle.actors[0]);
      const before = displayActor(actor, 0);
      actor.body.motion.phasing = null;
      expect(displayChanges([before], [displayActor(actor, 0)])).toEqual([]);
      actor.body.motion.position.x += 0.5;
      actor.vitals.resources.hp--;
      const after = displayActor(actor, 0);
      expect(displayChanges([before], [after])).toEqual([
        { id: before.id, position: after.position, resources: after.resources },
      ]);
      expect(before.position.x).not.toBe(after.position.x);
      expect(before.resources.hp).toBe(after.resources.hp + 1);
      const transaction = new StepTransaction(
        {
          battle,
          world,
          budget: DEFAULT_BUDGET,
          navigators: new Map(),
          work: new WorkMeter(DEFAULT_BUDGET),
        },
        { actors: [actor], melees: [], projectiles: [], ledger: new HitLedger(), serial: 0 },
        0,
        0,
        0,
        'boundary',
      );
      const objects = {
        spawn: [],
        update: [],
        remove: [{ id: 'object.1', reason: 'expired' as const }],
      };
      const changes = vi.spyOn(transaction, 'objectChanges').mockReturnValue(objects);
      expect(transaction.boundaryRecord().objects).toBe(objects);
      expect(changes).toHaveBeenCalledTimes(1);
      changes.mockClear();
      expect(transaction.intervalRecord().objects).toBe(objects);
      expect(changes).toHaveBeenCalledTimes(1);
      changes.mockRestore();
    } finally {
      world.free();
    }
  });
  it('caches immutable metadata without live usage or cross-revision IDs', async () => {
    const battle = await terrainBattle(),
      world = createBattleWorld(battle);
    try {
      const ordinary = battle.actors[0].abilities[0]!;
      const rescue = {
        ...ordinary,
        id: 'rescue',
        definition: {
          ...ordinary.definition,
          reaction: {
            response: {
              kind: 'revive' as const,
              health: { kind: 'fixed' as const, amount: 10 },
            },
          },
        },
      };
      const loadout = deepFreeze([rescue]);
      const ids = revivalAbilityIds(loadout);
      expect(ids).toEqual(['rescue']);
      expect(revivalAbilityIds(loadout)).toBe(ids);
      expect(Object.isFrozen(ids)).toBe(true);
      const actor = initialActor(world, { ...battle.actors[0], abilities: loadout });
      const first = displayActor(actor, 0);
      actor.actions.used.rescue = 2;
      expect(displayActor(actor, 0).revivals).toBe(2);
      expect(first.revivals).toBe(0);
      expect(revivalAbilityIds(deepFreeze([{ ...ordinary, id: 'rescue' }]))).toEqual([]);
      const mutable = [ordinary];
      expect(revivalAbilityIds(mutable)).toEqual([]);
      mutable.push(rescue);
      expect(revivalAbilityIds(mutable)).toEqual(['rescue']);
    } finally {
      world.free();
    }
  });
  it('measures final canonical bytes after event sorting and respects exact byte limits', () => {
    const journal = new Journal(9, 0, DEFAULT_BUDGET);
    for (const step of [2, 1])
      journal.emit({
        kind: 'diagnostic',
        phase: 'boundary',
        step,
        ruleId: 'test.bytes',
        reason: '一🙂',
      });
    const record: StreamRecord = {
      kind: 'boundary',
      schemaVersion: 1,
      step: 2,
      changes: [],
      events: journal.events,
    };
    const finished = journal.finish(record);
    const encoded = new TextEncoder().encode(canonicalJson(record)).byteLength + 1;
    expect(finished.bytes).toBe(encoded);
    expect(recordBytes(record)).toBe(encoded);
    expect(record.events.map((event) => [event.step, event.sequence])).toEqual([
      [1, 9],
      [2, 10],
    ]);
    const exact = new Journal(9, 7, {
      ...DEFAULT_BUDGET,
      maxFrameBytes: encoded,
      maxBytes: encoded + 7,
    });
    expect(exact.finish(record).bytes).toBe(encoded);
    for (const budget of [
      { ...DEFAULT_BUDGET, maxFrameBytes: encoded - 1 },
      { ...DEFAULT_BUDGET, maxBytes: encoded - 1 },
    ])
      expect(() => new Journal(9, 0, budget).finish(record)).toThrow('log-bytes');
  });
});
