import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { CharacterSchema, StreamRecordSchema } from '@fantasy/domain/spatial';
import { catalogManifest } from '@fantasy/samples';
import { runBattle } from './run.ts';
import { initializePhysics } from './physics.ts';
import { battleEvents, combatManifest } from '../../test-support/fixtures.ts';
import { locomotionFixture } from '../../test-support/locomotion.ts';
import { choosePolicy } from './policy.ts';
import { selfView } from './self-view.ts';

beforeAll(initializePhysics);
describe('resource-aware decisions and full matches', () => {
  it('reserves skill and jump resources before switching from walking to running', async () => {
    const f = await locomotionFixture();
    try {
      const unseen = choosePolicy(
        selfView(f.actor, 0, f.battle.rules.ai, f.battle.statuses),
        new Set(),
        false,
      );
      expect(unseen.gait).toBe('walk');
      f.actor.memory = {
        ...f.actor.memory,
        observation: {
          sampledAt: 0,
          availableAt: 5,
          enemy: {
            id: 'right',
            step: 0,
            position: { x: 4, y: 0.902, z: 0 },
            velocity: { x: 0, y: 0, z: 0 },
            facing: { x: -1, y: 0, z: 0 },
          },
          projectiles: [],
        },
      };
      const decide = (stamina: number) => {
        f.actor.resources.stamina = stamina;
        return choosePolicy(
          selfView(f.actor, 0, f.battle.rules.ai, f.battle.statuses),
          new Set(),
          false,
        );
      };
      expect(decide(100).gait).toBe('run');
      expect(decide(20).gait).toBe('walk');
      expect(decide(0).gait).toBe('slow');
      expect(decide(20).cognition?.locomotion).toMatchObject({ stamina: 20, reserveStamina: 8 });
    } finally {
      f.world.free();
    }
  });
  it('connects distance consumption, continuous recovery, decisions and finite battle resolution', async () => {
    const run = await runBattle(
      await catalogManifest('stamina-scout-v1', 'stamina-scout-v1', 'flat-surveyed-v1', 1000),
    );
    const events = battleEvents(run.records);
    expect(['win', 'draw']).toContain(run.result.outcome.kind);
    expect(events.some((e) => e.ruleId === 'movement.cost' && e.amount! > 0)).toBe(true);
    expect(events.some((e) => e.ruleId === 'resource.stamina-recovery')).toBe(true);
    expect(
      events.some((e) => e.ruleId === 'action.cost' && e.before!.stamina! > e.after!.stamina!),
    ).toBe(true);
    expect(
      events.some(
        (e) => e.cognition?.kind === 'decision' && e.cognition.locomotion?.gait === 'run',
      ),
    ).toBe(true);
    for (const record of run.records)
      expect(StreamRecordSchema.safeParse(record).success).toBe(true);
    expect(
      run.records.some(
        (record) =>
          record.kind === 'interval' &&
          record.changes.some((actor) => actor.locomotion?.mode === 'run'),
      ),
    ).toBe(true);
    expect(
      events
        .flatMap((event) => (event.after?.stamina === undefined ? [] : [event.after.stamina]))
        .every((value) => value >= 0),
    ).toBe(true);
  });
  it('uses paid flight in the real status and loop paths without changing free legacy flight', async () => {
    const paid = await runBattle(
      await catalogManifest('stamina-glider-v1', 'swordsman', 'flat-surveyed-v1', 100),
    );
    expect(
      battleEvents(paid.records).some(
        (e) => e.ruleId === 'movement.cost' && e.reason?.startsWith('flight'),
      ),
    ).toBe(true);
    const free = await runBattle(
      await catalogManifest('sky-mage', 'swordsman', 'flat-surveyed-v1', 100),
    );
    expect(battleEvents(free.records).some((e) => e.ruleId === 'movement.cost')).toBe(false);
  });
  it('keeps both exhausted actors moving even with zero recovery', async () => {
    const f = await locomotionFixture();
    try {
      const movement = CharacterSchema.parse(f.actor.motion.actor.character).movement;
      const manifest = await combatManifest(50, {
        character: { movement, stamina: { max: 100, recoveryPerSecond: 0 } },
        ability: {
          trigger: 'battle-start',
          target: 'self',
          attack: { kind: 'direct' },
          castSteps: 0,
          costs: { hp: 0, mp: 0, stamina: 100, uses: 1 },
          effects: [{ kind: 'shield', amount: 1 }],
        },
        policy: { movement: 'approach', preferredDistanceMm: 1000, priorities: [] },
      });
      const run = await runBattle(manifest);
      const paths = run.records.flatMap((r) => (r.kind === 'interval' ? r.paths : []));
      expect(
        paths
          .filter((p) => p.entityId === 'left')
          .at(-1)!
          .segments.at(-1)!.end.x,
      ).toBeGreaterThan(-3.7);
      expect(
        paths
          .filter((p) => p.entityId === 'right')
          .at(-1)!
          .segments.at(-1)!.end.x,
      ).toBeLessThan(3.7);
      expect(run.result.outcome).toEqual({ kind: 'draw', reason: 'time-limit' });
    } finally {
      f.world.free();
    }
  });
});
