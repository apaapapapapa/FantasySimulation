import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { AI_RULES, ExperienceSchema } from '@fantasy/domain/spatial';
import { initializePhysics, SpatialWorld } from './physics.ts';
import {
  emptyMemory,
  observeImpact,
  observeReveal,
  perceive,
  rememberExperience,
} from './perception.ts';
import { choosePolicy } from './policy.ts';
import { aiFixture, impactEvidence } from '../../test-support/ai.ts';
import { knownTerrainWorld } from './known-terrain.ts';
import { Navigator } from './navigation.ts';

beforeAll(initializePhysics);
describe('private delayed bounded cognition', () => {
  it('does not distinguish hidden enemy definitions with the same lawful visible appearance', async () => {
    const f = await aiFixture();
    try {
      const hidden = {
        ...f.enemy,
        actor: {
          ...f.enemy.actor,
          character: {
            ...f.enemy.actor.character,
            name: 'secret name',
            stats: {
              ...f.enemy.actor.character.stats,
              hp: 900,
              mp: 99999,
              resistances: {
                physical: 10000,
                fire: 10000,
                ice: 10000,
                lightning: 10000,
                arcane: 10000,
              },
            },
            abilities: [],
          },
          abilities: [],
        },
      };
      const observe = (enemy: typeof f.enemy, hp: number) => {
        let memory = perceive(f.world, f.self, enemy, [], 0, emptyMemory(), {
          resources: { hp, mp: 99999, shield: 99999 },
          action: 'idle',
        });
        memory = perceive(f.world, f.self, enemy, [], 5, memory, {
          resources: { hp, mp: 99999, shield: 99999 },
          action: 'idle',
        });
        return memory;
      };
      const ordinary = observe(f.enemy, 100),
        secret = observe(hidden, 900);
      expect(secret).toEqual(ordinary);
      const ready = new Set(f.abilities.map((a) => a.id));
      expect(choosePolicy({ ...f.view, memory: secret }, ready, false)).toEqual(
        choosePolicy({ ...f.view, memory: ordinary }, ready, false),
      );
      expect(Object.keys(secret.observation!.enemy!).sort()).toEqual([
        'action',
        'appearance',
        'facing',
        'id',
        'position',
        'size',
        'step',
        'velocity',
        'wounds',
      ]);
    } finally {
      f.world.free();
    }
  });
  it('learns coarse visible effects only after reaction, distinguishes confounders and never learns unseen zero damage', async () => {
    const f = await aiFixture();
    const wall = new SpatialWorld([
      {
        id: 'opaque',
        position: { x: 0, y: 1, z: 0 },
        halfExtents: { x: 0.1, y: 2, z: 4 },
        blocks: { movement: true, vision: true, attack: true },
      },
    ]);
    try {
      const detail = {
        ability: f.abilities[0]!,
        eventId: 'impact.1',
        element: 'fire' as const,
        basePower: 25,
        impact: 17,
        shield: false,
        partial: false,
      };
      expect(observeImpact(wall, f.self, f.enemy, detail, 0)).toBeNull();
      const experience = observeImpact(f.world, f.self, f.enemy, detail, 0)!;
      expect(ExperienceSchema.parse(experience)).toMatchObject({
        range: { low: 10, high: 20 },
        availableAt: 5,
        expiresAt: 500,
        kind: 'impact',
      });
      let memory = rememberExperience(emptyMemory(), experience);
      memory = perceive(f.world, f.self, f.enemy, [], 4, memory);
      expect(memory.knowledge).toHaveLength(0);
      memory = perceive(f.world, f.self, f.enemy, [], 5, memory);
      expect(memory.learned).toEqual([experience]);
      for (const flag of [{ shield: true }, { partial: true }])
        expect(observeImpact(f.world, f.self, f.enemy, { ...detail, ...flag }, 0)).toMatchObject({
          range: null,
          confidenceBps: 0,
        });
      memory = perceive(f.world, f.self, f.enemy, [], 500, memory);
      expect(memory.knowledge).toEqual([]);
      expect(memory.expired).toEqual(['impact.1']);
      expect(emptyMemory().knowledge).toEqual([]);
    } finally {
      wall.free();
      f.world.free();
    }
  });
  it('reveals one permitted field only on activation, with ward, occlusion, delay and expiry', async () => {
    const f = await aiFixture();
    try {
      const effect = {
        kind: 'reveal' as const,
        field: 'resistance' as const,
        element: 'fire' as const,
        precisionBps: 1000,
        durationSteps: 30,
        delaySteps: 5,
        occlusion: 'vision' as const,
        powerBps: 6000,
      };
      const target = {
        ...f.enemy,
        actor: {
          ...f.enemy.actor,
          character: {
            ...f.enemy.actor.character,
            stats: {
              ...f.enemy.actor.character.stats,
              resistances: { ...f.enemy.actor.character.stats.resistances, fire: 6500 },
            },
          },
        },
      };
      const acquired = observeReveal(
        f.world,
        f.self,
        target,
        effect,
        f.abilities[0]!,
        'reveal.1',
        0,
      )!;
      expect(acquired).toMatchObject({
        kind: 'reveal',
        element: 'fire',
        range: { low: 6000, high: 7000 },
        availableAt: 10,
        expiresAt: 30,
      });
      expect(
        observeReveal(
          f.world,
          f.self,
          {
            ...target,
            actor: {
              ...target.actor,
              character: {
                ...target.actor.character,
                perception: { ...target.actor.character.perception, revealWardBps: 6000 },
              },
            },
          },
          effect,
          f.abilities[0]!,
          'reveal.2',
          0,
        ),
      ).toBeNull();
      let memory = perceive(
        f.world,
        f.self,
        target,
        [],
        9,
        rememberExperience(emptyMemory(), acquired),
      );
      expect(memory.knowledge).toEqual([]);
      memory = perceive(f.world, f.self, target, [], 10, memory);
      expect(memory.knowledge).toHaveLength(1);
      expect(memory.knowledge[0]!.range).toEqual({ low: 6000, high: 7000 });
      memory = perceive(f.world, f.self, target, [], 30, memory);
      expect(memory.knowledge).toEqual([]);
    } finally {
      f.world.free();
    }
  });
  it('bounds independent FIFO histories and logs capacity eviction as expiration', async () => {
    const f = await aiFixture();
    try {
      let memory = emptyMemory();
      for (let i = 0; i < 100; i++)
        memory = rememberExperience(
          memory,
          impactEvidence(f.abilities[0]!, { eventId: `observed.${i}` }),
        );
      expect(memory.pendingExperience).toHaveLength(32);
      memory = perceive(f.world, f.self, f.enemy, [], 5, memory, undefined, 'surveyed', {
        ...AI_RULES,
        memorySamples: 2,
      });
      expect(memory.knowledge.map((e) => e.eventId)).toEqual(['observed.98', 'observed.99']);
      expect(memory.learned.length).toBeLessThanOrEqual(32);
      const next = rememberExperience(
        memory,
        impactEvidence(f.abilities[0]!, { eventId: 'new.1', availableAt: 6 }),
      );
      const advanced = perceive(f.world, f.self, f.enemy, [], 6, next, undefined, 'surveyed', {
        ...AI_RULES,
        memorySamples: 2,
      });
      expect(advanced.expired).toContain('observed.98');
      expect(memory.knowledge).toHaveLength(2);
      expect(emptyMemory().pendingExperience).toEqual([]);
    } finally {
      f.world.free();
    }
  });
  it('keeps navigation and danger checks independent of terrain that has not been observed', async () => {
    const f = await aiFixture();
    const hidden = new SpatialWorld([
      {
        id: 'behind',
        position: { x: -9, y: 2, z: 0 },
        halfExtents: { x: 0.1, y: 2, z: 4 },
        blocks: { movement: true, vision: true, attack: true },
      },
    ]);
    try {
      const memories = [f.world, hidden].map((world) => {
        const first = perceive(world, f.self, f.enemy, [], 0, emptyMemory(), undefined, 'observed');
        return perceive(world, f.self, f.enemy, [], 5, first, undefined, 'observed');
      });
      expect(memories[0]).toEqual(memories[1]);
      const results = memories.map((memory) => {
        const known = knownTerrainWorld(memory.terrain);
        try {
          return new Navigator(known, f.self.actor, f.battle.scenario, f.battle.rules, true).find(
            f.self.position,
            { ...f.self.position, x: 5 },
            false,
            100,
            false,
          );
        } finally {
          known.free();
        }
      });
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toMatchObject({ kind: 'path', visited: 0 });
    } finally {
      hidden.free();
      f.world.free();
    }
  });
});
