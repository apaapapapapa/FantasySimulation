import type { Manifest } from '@fantasy/domain/spatial';
import { combatManifest } from './fixtures.ts';
import { initialStatus, withInitialStatus } from './ai.ts';
import { reference } from '../src/spatial/prepare.ts';
import { sealRevision } from '../src/spatial/manifest-builder.ts';
import { reactionManifest } from './reactions.ts';

export async function diagnosticsRules(input: Manifest, enabled = true) {
  const old = input.revisions.find((r) => r.kind === 'ruleset' && r.id === input.ruleset.id)!;
  if (old.kind !== 'ruleset') throw new Error('Rules fixture required');
  const { interferenceDiagnostics: _, ...definition } = old.definition;
  const rules = await sealRevision('ruleset', 'interference-fixture-rules', 1, {
    ...definition,
    ...(enabled ? { interferenceDiagnostics: 'v1' as const } : {}),
  });
  input.revisions = input.revisions.filter((r) => r !== old);
  input.revisions.push(rules);
  input.ruleset = reference(rules);
  return input;
}
export const STATUS_CONFLICT_RULES = [
  'status.simultaneous-conflict',
  'status.existing-conflict',
  'status.permanent-conflict',
  'status.reaction-conflict',
] as const;
export async function statusConflictManifest(
  rule: (typeof STATUS_CONFLICT_RULES)[number],
  enabled = true,
) {
  if (rule === 'status.reaction-conflict')
    return diagnosticsRules(await reactionConflictManifest(), enabled);
  const incoming = await sealRevision(
    'status',
    'conflict-incoming',
    1,
    initialStatus({ stackKey: 'conflict' }),
  );
  const other = await sealRevision(
    'status',
    'conflict-other',
    1,
    initialStatus({
      stackKey: 'conflict',
      modifiers: { attack: 0, defense: 5, speedBps: 10000, flight: false, rooted: false },
    }),
  );
  const simultaneous = rule === 'status.simultaneous-conflict';
  const input = await combatManifest(20, {
    ability: {
      trigger: simultaneous ? 'battle-start' : 'action',
      target: simultaneous ? 'self' : 'enemy',
      attack: simultaneous ? { kind: 'direct' } : { kind: 'hitscan', radiusMm: 0 },
      rangeMm: 20000,
      castSteps: 0,
      condition: { kind: 'always' },
      costs: { hp: 1, mp: 2, uses: 1 },
      effects: [
        ...(!simultaneous
          ? [{ kind: 'damage' as const, amount: 10, element: 'fire' as const, attackScaleBps: 0 }]
          : []),
        ...[incoming, ...(simultaneous ? [other] : [])].map((status) => ({
          kind: 'apply-status' as const,
          status: reference(status),
        })),
      ],
    },
    policy: { movement: 'hold' },
  });
  input.revisions.push(incoming, ...(simultaneous ? [other] : []));
  if (!simultaneous)
    await withInitialStatus(
      input,
      0,
      initialStatus({
        stackKey: 'conflict',
        ...(rule === 'status.permanent-conflict' ? { categories: ['permanent'] } : {}),
      }),
    );
  return diagnosticsRules(input, enabled);
}

/** The same established cross-wave conflict, shared with the legacy regression. */
export async function reactionConflictManifest(
  point: 'before-hit' | 'after-damage' | 'before-defeat' = 'after-damage',
) {
  const input = await reactionManifest({
    reactions: [
      {
        trigger: point,
        reaction: { response: { kind: 'effects' } },
        effects: [{ kind: 'water', extinguish: true }],
      },
    ],
    ...(point === 'before-defeat'
      ? {
          attack: {
            effects: [
              {
                kind: 'damage' as const,
                amount: 10000,
                attackScaleBps: 0,
                element: 'fire' as const,
              },
            ],
          },
        }
      : {}),
  });
  const fire = await sealRevision(
    'status',
    'fire-form',
    1,
    initialStatus({ stackKey: 'fire-form' }),
  );
  const water = await sealRevision(
    'status',
    'water-form',
    1,
    initialStatus({ stackKey: 'water-form' }),
  );
  input.revisions.push(fire, water);
  await withInitialStatus(
    input,
    1,
    initialStatus({
      reactions: [
        { element: 'fire', response: { kind: 'transform', status: reference(fire) } },
        { element: 'water', response: { kind: 'transform', status: reference(water) } },
      ],
    }),
  );
  return input;
}

/** More simultaneous causes than one ability can hold, without bypassing admission. */
export async function startupConflictCauses(count: number) {
  const input = await statusConflictManifest('status.simultaneous-conflict');
  const base = input.revisions.find((r) => r.kind === 'ability')!;
  const character = input.revisions.find((r) => r.kind === 'character')!;
  const abilities = [];
  for (let start = 0; start < count; start += 16) {
    abilities.push(
      await sealRevision('ability', start === 0 ? base.id : `grant-${start}`, 1, {
        ...base.definition,
        costs: { hp: 0, mp: 0, uses: 1 },
        effects: Array.from(
          { length: Math.min(16, count - start) },
          (_, i) => base.definition.effects[(start + i) % 2]!,
        ),
      }),
    );
  }
  const next = await sealRevision('character', character.id, 1, {
    ...character.definition,
    abilities: abilities.map(reference),
  });
  input.revisions = input.revisions.filter((r) => r !== base && r !== character);
  input.revisions.push(...abilities, next);
  for (const actor of input.participants) actor.character = reference(next);
  return input;
}
