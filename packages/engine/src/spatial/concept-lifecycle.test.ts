import { expect, it } from 'vite-plus/test';
import { conceptManifest } from '../../test-support/concepts.ts';
import { initialStatus, withInitialStatus } from '../../test-support/ai.ts';
import {
  recoveryTargets,
  recoveryApplication,
  recoveryDamage,
} from '../../test-support/recovery.ts';
import { ManifestBuilder } from './manifest-builder.ts';
import { prepareBattle, reference } from './prepare.ts';
import { resolveEffects, type EffectTarget } from './rules/effects.ts';

it.each([1, 4])(
  'never refills a %i-use immortal guard after expiry regrant seal or explicit revival',
  async (protections) => {
    const targets: EffectTarget[] = await recoveryTargets();
    const guard = await ManifestBuilder.create(
      'status',
      'lifecycle-guard',
      1,
      initialStatus({
        maxStacks: 1,
        stacking: 'refresh',
        durationSteps: 10,
        immortality: { protections },
      }),
    );
    const seal = await ManifestBuilder.create(
      'status',
      'lifecycle-seal',
      1,
      initialStatus({ seals: { statusIds: [guard.id] } }),
    );
    const target = targets[1]!;
    const lethal = [recoveryApplication('lethal', recoveryDamage(20))];
    for (let used = 0; used <= protections; used++) {
      target.resources.hp = 10;
      target.immortalityUsed = used;
      target.statuses = [
        { revision: guard, startStep: 20, endStep: 30, stacks: 1, causes: ['regrant'] },
      ];
      const result = resolveEffects(targets, lethal, [guard, seal], 20)[1]!;
      expect(result.resources.hp).toBe(used < protections ? 1 : 0);
      expect(!!result.protection).toBe(used < protections);
      expect(resolveEffects(targets, lethal, [guard, seal], 30)[1]!.protection).toBeUndefined();
      target.statuses.push({
        revision: seal,
        startStep: 20,
        endStep: 25,
        stacks: 1,
        causes: ['seal'],
      });
      expect(resolveEffects(targets, lethal, [guard, seal], 21)[1]!.protection).toBeUndefined();
      target.statuses = [];
      expect(
        resolveEffects(
          targets,
          [
            ...lethal,
            recoveryApplication('new-guard', { kind: 'apply-status', status: reference(guard) }),
          ],
          [guard, seal],
          20,
        )[1]!.protection,
      ).toBeUndefined();
      expect(target.immortalityUsed).toBe(used);
    }
    target.statuses = [
      { revision: guard, startStep: 20, endStep: 30, stacks: 1, causes: ['revival'] },
    ];
    target.resources.hp = 7;
    expect(resolveEffects(targets, lethal, [guard], 21)[1]!.resources.hp).toBe(0);
    target.resources.hp = 0;
    target.immortalityUsed = 0;
    expect(resolveEffects(targets, lethal, [guard], 21)[1]!.protection).toBeUndefined();
  },
);

it('rejects conflicting immortal identities reachable through an opposing dormant grant before reservation', async () => {
  const input = await conceptManifest({ status: { immortality: { protections: 1 } } });
  await withInitialStatus(
    input,
    0,
    initialStatus({ maxStacks: 1, stacking: 'refresh', immortality: { protections: 1 } }),
  );
  const guard = input.revisions.find((r) => r.kind === 'status' && r.id === 'initial-status-0')!;
  const old = input.revisions.find((r) => r.kind === 'ability' && r.id === 'reaction-primary')!;
  if (old.kind !== 'ability') throw new Error('Primary ability');
  const grant = await ManifestBuilder.create('ability', old.id, 1, {
    ...old.definition,
    condition: { kind: 'visible', value: false },
    effects: [{ kind: 'apply-status', status: reference(guard) }],
  });
  const conflict = await ManifestBuilder.relink(input, [{ from: old, to: grant }]);
  await expect(prepareBattle(conflict)).rejects.toMatchObject({
    code: 'unsupported-mechanic',
    mechanic: 'immortality',
  });
});
