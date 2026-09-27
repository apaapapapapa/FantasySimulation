import { expect, it } from 'vite-plus/test';
import arithmetic from '../../../../docs/adr/0018-p6-concept-cases.json' with { type: 'json' };
import {
  recoveryTargets,
  recoveryApplication,
  recoveryDamage,
} from '../../test-support/recovery.ts';
import { initialStatus } from '../../test-support/ai.ts';
import { sealRevision } from './manifest-builder.ts';
import { resolveEffects, type EffectApplication, type EffectTarget } from './rules/effects.ts';

it('executes the fourteen independently authored guard/drain cases and both participant orders', async () => {
  const baseline = await recoveryTargets();
  for (const [name, fixture] of Object.entries(arithmetic.arithmeticCases)) {
    const targets: EffectTarget[] = structuredClone(baseline);
    const applications: EffectApplication[] = [];
    for (const [index, input] of [fixture.a, fixture.b].entries()) {
      const row = { ...arithmetic.arithmeticModel.defaults, ...input };
      const target = targets[index]!;
      const id = target.actor.participant.actorId;
      target.resources.hp = row.hp;
      target.actor = {
        ...target.actor,
        character: {
          ...target.actor.character,
          stats: { ...target.actor.character.stats, hp: row.maxHp },
        },
      };
      const status = await sealRevision(
        'status',
        `arithmetic-${index}`,
        1,
        initialStatus({
          maxStacks: 1,
          stacking: 'refresh',
          ...(row.eligibleGuard ? { immortality: { protections: 1 } } : {}),
          adjustments: [{ target: 'hpRecovery', operation: 'multiply', amount: row.hpRecoveryBps }],
        }),
      );
      target.statuses = [{ revision: status, startStep: 0, endStep: 100, stacks: 1, causes: [] }];
      applications.push(
        recoveryApplication(
          `damage-${id}`,
          recoveryDamage(row.incomingDamage, row.drainBpsOnIncoming),
          id,
        ),
      );
      if (row.ordinaryHealing)
        applications.push(
          recoveryApplication(`heal-${id}`, { kind: 'heal', amount: row.ordinaryHealing }, id),
        );
      if (row.defeat)
        applications.push(recoveryApplication(`defeat-${id}`, { kind: 'defeat' }, id));
    }
    for (const reverse of [false, true]) {
      const results = resolveEffects(
        reverse ? [...targets].reverse() : targets,
        reverse ? [...applications].reverse() : applications,
        [],
        0,
      );
      for (const [index, expected] of [fixture.expected.a, fixture.expected.b].entries()) {
        const result = results[index]!;
        expect(result.resources.hp, name).toBe(expected.hp);
        expect(Number(!!result.protection), name).toBe(expected.guardUse);
        for (const damage of result.damage)
          if (damage.drain)
            expect(damage.drain.basis, name).toEqual({
              numerator: String(expected.drainBasis),
              denominator: '1',
            });
        const credited = results[1 - index]!.damage.reduce(
          (sum, damage) => sum + (damage.drain?.healing ?? 0),
          0,
        );
        expect(credited, name).toBe(expected.drainReceived);
      }
    }
  }
});
