import { describe, expect, it } from 'vite-plus/test';
import fixture from '../../fixtures/replay/mutual-hit.json' with { type: 'json' };
import { AbilitySchema } from './contracts.ts';
import { ExperienceSchema } from './cognition.ts';
import { EventSchema } from './records.ts';

describe('bounded subjective record contract', () => {
  it('keeps authoritative resources out of cognition and requires the declared perspective and kind', () => {
    const old = EventSchema.parse(
      fixture.records.flatMap<unknown>((r) => ('events' in r ? r.events : []))[0],
    );
    const input = {
      ...old,
      kind: 'knowledge',
      actorId: 'left',
      before: null,
      after: null,
      amount: null,
      damage: null,
      cognition: { kind: 'knowledge', perspective: 'subjective', learned: [], expired: [] },
    };
    expect(EventSchema.safeParse(input).success).toBe(true);
    for (const edit of [
      { kind: 'damage' },
      { actorId: null },
      { before: { hp: 10, mp: 20, shield: 0 } },
      { amount: 3 },
      { cognition: { ...input.cognition, perspective: 'omniscient' } },
    ]) {
      expect(EventSchema.safeParse({ ...input, ...edit }).success).toBe(false);
    }
    expect(
      EventSchema.safeParse({
        ...input,
        cognition: { ...input.cognition, expired: Array(33).fill('old.1') },
      }).success,
    ).toBe(false);
  });
  it('rejects unsupported information effects and malformed knowledge chronology or range', () => {
    const base = fixture.input.revisions.find((r) => r.kind === 'ability')!.definition;
    const effect = {
      kind: 'reveal',
      field: 'resistance',
      element: 'fire',
      precisionBps: 1000,
      durationSteps: 100,
      delaySteps: 5,
      occlusion: 'vision',
      powerBps: 6000,
    };
    const ability = {
      ...base,
      target: 'enemy',
      attack: { kind: 'hitscan', radiusMm: 0 },
      effects: [effect],
    };
    expect(AbilitySchema.safeParse(ability).success).toBe(true);
    expect(
      AbilitySchema.safeParse({ ...ability, effects: [{ ...effect, field: 'future-random' }] })
        .success,
    ).toBe(false);
    expect(
      AbilitySchema.safeParse({ ...ability, attack: { kind: 'hitscan', radiusMm: 100 } }).success,
    ).toBe(false);
    const knowledge = {
      eventId: 'seen.1',
      targetId: 'right',
      ability: { id: 'read', revision: 1, contentHash: 'sha256:' + '1'.repeat(64) },
      element: 'fire',
      kind: 'reveal',
      sampledAt: 10,
      availableAt: 20,
      expiresAt: 100,
      basePower: 0,
      distanceBand: 0,
      range: { low: 1000, high: 2000 },
      confidenceBps: 10000,
    };
    expect(ExperienceSchema.safeParse(knowledge).success).toBe(true);
    for (const edit of [
      { availableAt: 9 },
      { expiresAt: 9 },
      { range: null },
      { range: { low: 9000, high: 10001 } },
      { kind: 'shield' },
    ])
      expect(ExperienceSchema.safeParse({ ...knowledge, ...edit }).success).toBe(false);
  });
});
