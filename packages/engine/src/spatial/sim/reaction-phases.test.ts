import { expect, it } from 'vite-plus/test';
import type { PendingEffect } from './combat-effects.ts';
import { positiveDamageApplications, type ResolvedDamageWave } from './reaction-phases.ts';

function application(id: string, kind: 'damage' | 'heal'): PendingEffect & { id: string } {
  return {
    id,
    actorId: 'left',
    targetId: 'right',
    abilityId: 'test-ability',
    parentEventId: 'contact',
    causes: ['origin'],
    attack: 0,
    effect:
      kind === 'damage'
        ? { kind, amount: 10, attackScaleBps: 0, element: 'fire' }
        : { kind, amount: 100 },
  };
}

it('projects only positive attributed damage and preserves input and causal ancestry', () => {
  const wave: ResolvedDamageWave = {
    applications: [application('hit', 'damage'), application('parried', 'damage')],
    resolved: [
      {
        damage: [
          { applicationId: 'hit', toHp: { numerator: '1' } },
          { applicationId: 'parried', toHp: { numerator: '0' } },
        ],
      },
    ],
  };
  const previous = structuredClone(wave);
  expect(positiveDamageApplications(wave)).toEqual([
    { ...wave.applications[0], parentEventId: 'hit' },
  ]);
  expect(wave).toEqual(previous);
});

it('does not use simultaneous healing or missing damage attribution as a damage trigger', () => {
  const wave: ResolvedDamageWave = {
    applications: [application('heal', 'heal'), application('missing', 'damage')],
    resolved: [{ damage: [{ applicationId: 'heal', toHp: { numerator: '10' } }] }],
  };
  expect(positiveDamageApplications(wave)).toEqual([]);
});
