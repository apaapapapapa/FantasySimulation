import type { Definition, Manifest } from '@fantasy/domain/spatial';
import { reactionManifest } from './reactions.ts';
import { experimentalRules } from '@fantasy/samples/testing';
import { revisionClosure } from '@fantasy/samples';
import { combatManifest } from './fixtures.ts';
import { ManifestBuilder } from '../src/spatial/manifest-builder.ts';
import { reference } from '../src/spatial/prepare.ts';
import { spatialTransaction } from './spatial-objects.ts';
import { initializePhysics } from '../src/spatial/world/physics.ts';
import { activateStops } from '../src/spatial/sim/time-stop-control.ts';
import { emptyStopState } from '../src/spatial/sim/time-stop-state.ts';
import { stopEffectHooks } from '../src/spatial/sim/time-stop-effects.ts';
import type { EffectContext, PendingEffect } from '../src/spatial/sim/combat-effects.ts';

export async function stopManifest(
  options: {
    both?: boolean;
    duration?: number;
    steps?: number;
    sourceAttack?: Partial<Definition<'ability'>>;
    targetAttack?: Partial<Definition<'ability'>>;
  } = {},
) {
  let manifest = await combatManifest(options.steps ?? 30, {
    ids: { ability: 'stop-primary', character: 'stop-fixture', policy: 'stop-fixture-policy' },
    ability: {
      timeStop: { durationSteps: options.duration ?? 5 },
      effects: [],
      castSteps: 0,
      recoverySteps: 1,
      cooldownSteps: 0,
      costs: { hp: 0, mp: 2, uses: 1 },
      condition: { kind: 'always' },
      attack: { kind: 'hitscan', radiusMm: 0 },
      rangeMm: 20000,
      aimErrorMilliDegrees: 0,
    },
    policy: { movement: 'hold' },
    character: {
      stats: {
        hp: 40,
        mp: 30,
        shield: 0,
        attack: 0,
        defense: 0,
        actionSpeedBps: 10000,
        resistances: { physical: 0, fire: 0, ice: 0, lightning: 0, arcane: 0 },
      },
    },
  });
  const primary = manifest.revisions.find((revision) => revision.kind === 'ability')!;
  const base = manifest.revisions.find((revision) => revision.kind === 'character')!;
  const policy = manifest.revisions.find((revision) => revision.kind === 'policy')!;
  for (const index of [0, 1] as const) {
    const { timeStop: _, ...shot } = primary.definition;
    const attack = await ManifestBuilder.create('ability', `stop-shot-${index}`, 1, {
      ...shot,
      effects: [
        { kind: 'damage', amount: 4, attackScaleBps: 0, element: 'physical', defense: 'none' },
      ],
      costs: { hp: 0, mp: 0, uses: 0 },
      ...(index === 0 ? options.sourceAttack : options.targetAttack),
    });
    const abilities = options.both ? [primary] : index === 0 ? [primary, attack] : [attack];
    const ownPolicy = await ManifestBuilder.create('policy', `stop-policy-${index}`, 1, {
      ...policy.definition,
      priorities: abilities.map((ability) => ({ abilityId: ability.id, when: { kind: 'always' } })),
    });
    const actor = await ManifestBuilder.create('character', `stop-actor-${index}`, 1, {
      ...base.definition,
      abilities: abilities.map(reference),
      policy: reference(ownPolicy),
    });
    manifest.revisions.push(attack, ownPolicy, actor);
    manifest.participants[index].character = reference(actor);
  }
  manifest = await experimentalRules(manifest, [
    'absolute-evasion',
    'absolute-hit',
    'immortality',
    'instant-death',
    'mind-read',
    'time-stop',
  ]);
  manifest.revisions = revisionClosure(manifest.revisions, [
    ...manifest.participants.map((participant) => ({
      kind: 'character' as const,
      ref: participant.character,
    })),
    { kind: 'ruleset', ref: manifest.ruleset },
    { kind: 'scenario', ref: manifest.scenario },
  ]);
  return manifest;
}

export function stopDamage(
  actorId: string,
  targetId: string,
  amount: number,
  drainBps?: number,
): PendingEffect {
  return {
    actorId,
    targetId,
    abilityId: `stop-shot-${actorId === 'left' ? 0 : 1}`,
    parentEventId: 'e.1',
    attack: 0,
    effect: {
      kind: 'damage',
      amount,
      attackScaleBps: 0,
      element: 'physical',
      defense: 'none',
      ...(drainBps ? { drainBps } : {}),
    },
  };
}

/** Paid control boundary shared by clock/queue tests; expected values stay in the cases. */
export async function stoppedTransaction(manifest?: Manifest) {
  await initializePhysics();
  const fixture = await spatialTransaction({ manifest: manifest ?? (await stopManifest()) }),
    tx = fixture.tx;
  const ability = tx.next.actors[0]!.body.motion.actor.abilities.find(
    (candidate) => candidate.definition.timeStop,
  )!;
  tx.next.stop = emptyStopState();
  tx.next.stop.requests.push({
    id: 't.fixture',
    ownerId: 'left',
    targetId: 'right',
    ability,
    cause: 'e.0',
    at: 1,
    duration: 5,
  });
  activateStops(tx);
  const base: EffectContext = {
    ...fixture.context,
    journal: tx.journal,
    step: 1,
    activationStep: 2,
    phase: 'resolution',
  };
  const hooks = stopEffectHooks(tx, base);
  return { ...fixture, base, hooks, effectContext: { ...base, ...hooks } };
}

export async function withStopReactions(
  input: Manifest,
  index: 0 | 1,
  definitions: Partial<Definition<'ability'>>[],
) {
  const template = await reactionManifest({ reactions: definitions });
  const reactions = await Promise.all(
    template.revisions.flatMap((r) =>
      r.kind === 'ability' && r.definition.reaction
        ? [ManifestBuilder.create('ability', `stop-${index}-${r.id}`, 1, r.definition)]
        : [],
    ),
  );
  const character = input.revisions.find(
    (r) => r.kind === 'character' && r.id === input.participants[index].character.id,
  )!;
  if (character.kind !== 'character') throw new Error('Stop participant');
  const own = await ManifestBuilder.create('character', character.id, 1, {
    ...character.definition,
    abilities: [...character.definition.abilities, ...reactions.map(reference)],
  });
  return ManifestBuilder.relink({ ...input, revisions: [...input.revisions, ...reactions] }, [
    { from: character, to: own },
  ]);
}

export const stopClockManifest = (targetAttack: Partial<Definition<'ability'>>) =>
  stopManifest({
    duration: 12,
    steps: 45,
    sourceAttack: {
      effects: [
        { kind: 'damage', amount: 0, attackScaleBps: 0, element: 'physical', defense: 'none' },
      ],
    },
    targetAttack: { costs: { hp: 0, mp: 0, uses: 1 }, ...targetAttack },
  });
